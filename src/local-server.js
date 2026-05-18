import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)
const LOCAL_VERSION = (() => { try { return _require('../package.json').version } catch { return '0.0.0' } })()
import { loadState } from './state.js'
import { pairNodeDirect } from './pairing.js'
import { getSystemInfo } from './system-info.js'
import { getLines } from './log-buffer.js'

const downloads = new Map() // model -> { status, progress, done, success, startedAt }

const PORT = 47821
const UI_DIST = join(import.meta.dirname, '..', 'ui', 'dist')

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function json(res, data, status = 200) {
  cors(res)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function serveStatic(res, filePath) {
  if (!existsSync(filePath)) {
    // SPA fallback
    const index = join(UI_DIST, 'index.html')
    if (existsSync(index)) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(readFileSync(index))
    } else {
      res.writeHead(404)
      res.end('UI not built. Run: npm run build:ui')
    }
    return
  }
  const ext = extname(filePath)
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
  res.end(readFileSync(filePath))
}

export function startLocalServer({ getRelayStatus, getRelayError, onPaired, getRelay } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`)

    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end() }

    // Health (used by spinny.au browser fetch)
    if (url.pathname === '/health') {
      const state = loadState()
      return json(res, { ok: true, nodeId: state.nodeId, paired: state.paired, health: getSystemInfo() })
    }

    // API status
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const state = loadState()
      return json(res, {
        paired: state.paired,
        nodeId: state.nodeId,
        accountId: state.accountId,
        relayConnected: getRelayStatus?.() ?? false,
        relayError: getRelayError?.() ?? null,
        version: getSystemInfo().version,
        pairingCode: state.pairingCode || null,
      })
    }

    // API system info
    if (url.pathname === '/api/system' && req.method === 'GET') {
      return json(res, getSystemInfo())
    }

    // API logs
    if (url.pathname === '/api/logs' && req.method === 'GET') {
      const n = parseInt(url.searchParams.get('n') || '200', 10)
      return json(res, { lines: getLines(n) })
    }

    // Reconnect relay
    if (url.pathname === '/api/relay/reconnect' && req.method === 'POST') {
      const relay = getRelay?.()
      if (!relay) return json(res, { error: 'Relay not initialised' }, 503)
      relay.connect().catch(() => {})
      return json(res, { ok: true })
    }

    // Install model — SSE progress, download continues if tab closes
    if (url.pathname === '/api/models/install' && req.method === 'POST') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => {
        let model
        try { ;({ model } = JSON.parse(body)) } catch { return json(res, { error: 'Invalid request' }, 400) }
        if (!model) return json(res, { error: 'model required' }, 400)
        if (!/^[\w.:/\-]+$/.test(model)) return json(res, { error: 'Invalid model name' }, 400)

        cors(res)
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
        let connOpen = true
        req.on('close', () => { connOpen = false })
        const safeSend = (data) => {
          if (!connOpen || res.writableEnded) return
          try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {}
        }

        // If already in progress, attach as observer polling the map
        const existing = downloads.get(model)
        if (existing && !existing.done) {
          safeSend({ status: existing.status, progress: existing.progress })
          const poll = setInterval(() => {
            const dl = downloads.get(model)
            if (!dl) { clearInterval(poll); if (!res.writableEnded) res.end(); return }
            safeSend({ status: dl.status, progress: dl.progress })
            if (dl.done) { clearInterval(poll); safeSend({ done: true, success: dl.success, model }); if (!res.writableEnded) res.end() }
          }, 500)
          req.on('close', () => clearInterval(poll))
          return
        }

        downloads.set(model, { status: `Starting download: ${model}`, progress: null, done: false, success: false, startedAt: Date.now() })
        safeSend({ status: `Starting download: ${model}` })

        const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')

        const proc = spawn('ollama', ['pull', model], { stdio: ['ignore', 'pipe', 'pipe'] })
        const onData = (chunk) => {
          const lines = chunk.toString().split(/\r?\n/).map(stripAnsi).filter(l => l.trim())
          for (const line of lines) {
            const pct = line.match(/(\d+)%/)
            const progress = pct ? parseInt(pct[1]) : (downloads.get(model)?.progress ?? null)
            downloads.set(model, { ...downloads.get(model), status: line, progress })
            safeSend({ status: line, progress })
          }
        }
        proc.stdout.on('data', onData)
        proc.stderr.on('data', onData)
        proc.on('close', (code) => {
          const success = code === 0
          downloads.set(model, { ...downloads.get(model), done: true, success, progress: success ? 100 : null })
          safeSend({ done: true, success, model })
          if (!res.writableEnded) res.end()
          if (success) {
            try {
              const relay = getRelay?.()
              if (relay) relay.send({ type: 'node.health', issuedAt: new Date().toISOString(), health: getSystemInfo() })
            } catch {}
          }
          setTimeout(() => downloads.delete(model), 60_000)
        })
        // NO proc.kill on close — download continues in background
      })
      return
    }

    // Active downloads — UI polls this every 2s to show progress
    if (url.pathname === '/api/models/downloading' && req.method === 'GET') {
      const result = {}
      for (const [k, v] of downloads) result[k] = { status: v.status, progress: v.progress, done: v.done, success: v.success }
      return json(res, result)
    }

    // Chat — proxies to local ollama, streams SSE
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', async () => {
        let parsed
        try { parsed = JSON.parse(body) } catch { return json(res, { error: 'Invalid request' }, 400) }
        const { model, messages } = parsed
        if (!model || !Array.isArray(messages)) return json(res, { error: 'model and messages required' }, 400)
        cors(res)
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
        const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {} }
        try {
          const ollamaRes = await fetch('http://localhost:11434/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages, stream: true }),
          })
          if (!ollamaRes.ok) { send({ error: `Ollama error ${ollamaRes.status}: is the model installed?` }); return res.end() }
          const reader = ollamaRes.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            const lines = buf.split('\n')
            buf = lines.pop() ?? ''
            for (const line of lines) {
              if (!line.trim()) continue
              try {
                const chunk = JSON.parse(line)
                send({ content: chunk.message?.content ?? '', done: chunk.done ?? false })
              } catch {}
            }
          }
        } catch (err) {
          send({ error: err.message })
        }
        res.end()
      })
      return
    }

    // Code-based direct pairing endpoint
    if (url.pathname === '/pair-direct') {
      const code = url.searchParams.get('code')
      const email = url.searchParams.get('email')
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Content-Type': 'application/json',
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders)
        return res.end()
      }

      const state = loadState()
      if (!code || code.toUpperCase() !== (state.pairingCode || '').toUpperCase()) {
        res.writeHead(400, corsHeaders)
        return res.end(JSON.stringify({ error: 'Invalid pairing code' }))
      }
      if (!email || !email.includes('@')) {
        res.writeHead(400, corsHeaders)
        return res.end(JSON.stringify({ error: 'Valid email required' }))
      }
      try {
        const result = await pairNodeDirect({ accountEmail: email })
        res.writeHead(200, corsHeaders)
        res.end(JSON.stringify({ ok: true, nodeId: result.nodeId }))
        onPaired?.(result)
      } catch (err) {
        res.writeHead(500, corsHeaders)
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // Check for updates — compare local version to GitHub package.json
    if (url.pathname === '/api/update/check' && req.method === 'GET') {
      try {
        const ghRes = await fetch('https://raw.githubusercontent.com/spinny-au/spinny-local-minimal/main/package.json')
        const ghPkg = await ghRes.json()
        const remoteVersion = ghPkg.version || '0.0.0'
        return json(res, { updateAvailable: remoteVersion !== LOCAL_VERSION, localVersion: LOCAL_VERSION, remoteVersion })
      } catch (err) {
        return json(res, { updateAvailable: false, localVersion: LOCAL_VERSION, error: err.message })
      }
    }

    // Apply update — git pull + npm install, streamed as SSE
    if (url.pathname === '/api/update/apply' && req.method === 'POST') {
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
      const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
      const cwd = join(import.meta.dirname, '..')
      send({ status: 'Pulling latest code…' })
      const pull = spawn('git', ['pull', 'origin', 'main'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      const onChunk = (chunk) => chunk.toString().split('\n').filter(l => l.trim()).forEach(l => send({ status: l }))
      pull.stdout.on('data', onChunk)
      pull.stderr.on('data', onChunk)
      pull.on('close', (code) => {
        if (code !== 0) { send({ done: true, success: false }); return res.end() }
        send({ status: 'Installing dependencies…' })
        const install = spawn('npm', ['install', '--omit=dev'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        install.stdout.on('data', onChunk)
        install.stderr.on('data', onChunk)
        install.on('close', (c) => { send({ done: true, success: c === 0 }); res.end() })
      })
      req.on('close', () => pull.kill())
      return
    }

    // Serve React app static files
    if (req.method === 'GET') {
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname
      const filePath = join(UI_DIST, pathname)
      return serveStatic(res, filePath)
    }

    res.writeHead(404)
    res.end()
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Spinny local panel: http://localhost:${PORT}`)
  })
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') console.error('Local server error:', err.message)
  })

  return server
}
