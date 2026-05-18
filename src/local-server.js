import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { loadState } from './state.js'
import { pairNodeDirect } from './pairing.js'
import { getSystemInfo } from './system-info.js'
import { getLines } from './log-buffer.js'

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

    // Install model — streams SSE progress
    if (url.pathname === '/api/models/install' && req.method === 'POST') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => {
        let model
        try {
          ;({ model } = JSON.parse(body))
        } catch {
          return json(res, { error: 'Invalid request' }, 400)
        }
        if (!model) return json(res, { error: 'model required' }, 400)
        if (!/^[\w.:/\-]+$/.test(model)) return json(res, { error: 'Invalid model name' }, 400)

        cors(res)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
        })

        const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
        send({ status: `Starting download: ${model}` })

        const proc = spawn('ollama', ['pull', model], { stdio: ['ignore', 'pipe', 'pipe'] })

        const onData = (chunk) => {
          const lines = chunk.toString().split('\n').filter(l => l.trim())
          for (const line of lines) send({ status: line })
        }
        proc.stdout.on('data', onData)
        proc.stderr.on('data', onData)

        proc.on('close', (code) => {
          send({ done: true, success: code === 0, model })
          res.end()
        })

        req.on('close', () => proc.kill())
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
