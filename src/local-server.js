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
import { Vault } from './vault.js'
import { exportModelBundle, importModelBundle, importModelBundleFromUrl, getBundleReadStream } from './model-bundles.js'

const downloads = new Map() // model -> { status, progress, done, success, startedAt }

const VAULT_NS = 'byok'
const SPINNY_ORIGIN = 'https://spinny.au'

const CLOUD_APIS = {
  openai:      { url: 'https://api.openai.com/v1/chat/completions',       format: 'openai'    },
  xai:         { url: 'https://api.x.ai/v1/chat/completions',             format: 'openai'    },
  openrouter:  { url: 'https://openrouter.ai/api/v1/chat/completions',    format: 'openai'    },
  anthropic:   { url: 'https://api.anthropic.com/v1/messages',            format: 'anthropic' },
}

function maskKey(key) {
  if (!key || key.length < 8) return '****'
  return key.slice(0, 8) + '****'
}

function corsSpinny(res) {
  res.setHeader('Access-Control-Allow-Origin', SPINNY_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
  res.setHeader('Vary', 'Origin')
}

function isTrustedOrigin(req) {
  const origin = req.headers.origin || ''
  return !origin
    || origin === SPINNY_ORIGIN
    || origin.startsWith(`http://localhost:${PORT}`)
    || origin.startsWith(`http://127.0.0.1:${PORT}`)
}

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

function json(res, data, status = 200, corsOverride = null) {
  if (corsOverride) corsOverride(res); else cors(res)
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

    if (req.method === 'OPTIONS') {
      const p = url.pathname
      const origin = req.headers.origin || '(no origin)'
      const pna = req.headers['access-control-request-private-network']
      if (p.startsWith('/api/vault/') || p === '/api/cloud-chat' || p === '/api/models') {
        console.log(`[preflight] OPTIONS ${p} origin="${origin}" pna=${pna || 'not-requested'}`)
        corsSpinny(res)
      } else cors(res)
      res.writeHead(204); return res.end()
    }

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

    // Export an installed Ollama model as a portable Spinny bundle.
    if (url.pathname === '/api/models/bundle/export' && req.method === 'GET') {
      try {
        const model = url.searchParams.get('model') || ''
        return json(res, exportModelBundle(model))
      } catch (error) {
        return json(res, { error: error.message }, 400)
      }
    }

    // Download a portable Spinny model bundle.
    if (url.pathname === '/api/models/bundle/download' && req.method === 'GET') {
      try {
        const model = url.searchParams.get('model') || ''
        const bundle = getBundleReadStream(model)
        cors(res)
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${bundle.fileName}"`,
          'Content-Length': String(bundle.bytes),
        })
        return bundle.stream.pipe(res)
      } catch (error) {
        return json(res, { error: error.message }, 400)
      }
    }

    // Import a portable Spinny model bundle from a local path or URL.
    if (url.pathname === '/api/models/bundle/import' && req.method === 'POST') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body)
          const result = parsed.url
            ? await importModelBundleFromUrl(parsed.url, parsed.model)
            : importModelBundle(parsed.path)
          const relay = getRelay?.()
          if (relay) relay.send({ type: 'node.health', issuedAt: new Date().toISOString(), health: getSystemInfo() })
          return json(res, result)
        } catch (error) {
          return json(res, { error: error.message }, 400)
        }
      })
      return
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

    // ── Request log for vault / cloud-chat / models ───────────────────────
    if (url.pathname.startsWith('/api/vault') || url.pathname === '/api/cloud-chat' || url.pathname === '/api/models') {
      const origin = req.headers.origin || '(no origin)'
      const trusted = isTrustedOrigin(req)
      console.log(`[vault] ${req.method} ${url.pathname} origin="${origin}" trusted=${trusted}`)
    }

    // ── Vault: list stored providers (masked) ─────────────────────────────
    if (url.pathname === '/api/vault/keys' && req.method === 'GET') {
      const vault = new Vault()
      try {
        const items = vault.list(VAULT_NS, 50)
        const keys = items.map(({ key: provider, value }) => ({
          provider,
          preview: value?.key ? maskKey(value.key) : '****',
          storedAt: value?.storedAt || null,
        }))
        return json(res, { keys }, 200, corsSpinny)
      } finally { vault.close() }
    }

    // ── Vault: store a key ────────────────────────────────────────────────
    if (url.pathname === '/api/vault/keys' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinny)
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => {
        let parsed
        try { parsed = JSON.parse(body) } catch { return json(res, { error: 'Invalid request' }, 400, corsSpinny) }
        const { provider, key } = parsed
        if (!provider || !key) return json(res, { error: 'provider and key required' }, 400, corsSpinny)
        if (!/^[\w-]+$/.test(provider)) return json(res, { error: 'Invalid provider name' }, 400, corsSpinny)
        if (key.length < 8) return json(res, { error: 'Key too short' }, 400, corsSpinny)
        const vault = new Vault()
        try {
          vault.put(VAULT_NS, provider, { key, storedAt: new Date().toISOString() })
          return json(res, { ok: true, provider, preview: maskKey(key) }, 200, corsSpinny)
        } finally { vault.close() }
      })
      return
    }

    // ── Vault: delete a key ───────────────────────────────────────────────
    const vaultDel = url.pathname.match(/^\/api\/vault\/keys\/([\w-]+)$/)
    if (vaultDel && req.method === 'DELETE') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinny)
      const provider = vaultDel[1]
      const vault = new Vault()
      try {
        vault.db.prepare('DELETE FROM encrypted_items WHERE namespace = ? AND item_key = ?').run(VAULT_NS, provider)
        return json(res, { ok: true, provider }, 200, corsSpinny)
      } finally { vault.close() }
    }

    // ── Cloud chat: use vault key to call AI provider, stream SSE ─────────
    if (url.pathname === '/api/cloud-chat' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinny)
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', async () => {
        let parsed
        try { parsed = JSON.parse(body) } catch { return json(res, { error: 'Invalid request' }, 400, corsSpinny) }
        const { provider, model, messages } = parsed
        if (!provider || !model || !Array.isArray(messages)) return json(res, { error: 'provider, model and messages required' }, 400, corsSpinny)
        if (!CLOUD_APIS[provider]) return json(res, { error: `Unknown provider: ${provider}` }, 400, corsSpinny)

        const vault = new Vault()
        let apiKey
        try {
          const entry = vault.get(VAULT_NS, provider)
          apiKey = entry?.key
        } finally { vault.close() }
        if (!apiKey) return json(res, { error: `No vault key stored for: ${provider}` }, 401, corsSpinny)

        corsSpinny(res)
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
        const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {} }

        try {
          const api = CLOUD_APIS[provider]
          if (api.format === 'anthropic') {
            const r = await fetch(api.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({ model, messages, max_tokens: 8096, stream: true }),
            })
            if (!r.ok) { send({ error: `Anthropic ${r.status}: ${await r.text()}` }); return res.end() }
            const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''
            while (true) {
              const { done, value } = await reader.read(); if (done) break
              buf += dec.decode(value, { stream: true })
              const lines = buf.split('\n'); buf = lines.pop() ?? ''
              for (const line of lines) {
                if (!line.startsWith('data:')) continue
                const d = line.slice(5).trim(); if (!d) continue
                try {
                  const evt = JSON.parse(d)
                  if (evt.type === 'content_block_delta' && evt.delta?.text) send({ content: evt.delta.text, done: false })
                  else if (evt.type === 'message_stop') send({ content: '', done: true })
                } catch {}
              }
            }
          } else {
            // OpenAI-compatible (openai, xai, openrouter)
            const headers = { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` }
            if (provider === 'openrouter') { headers['http-referer'] = 'https://spinny.au'; headers['x-title'] = 'Spinny' }
            const r = await fetch(api.url, {
              method: 'POST',
              headers,
              body: JSON.stringify({ model, messages, stream: true }),
            })
            if (!r.ok) { send({ error: `${provider} ${r.status}: ${await r.text()}` }); return res.end() }
            const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''
            while (true) {
              const { done, value } = await reader.read(); if (done) break
              buf += dec.decode(value, { stream: true })
              const lines = buf.split('\n'); buf = lines.pop() ?? ''
              for (const line of lines) {
                if (!line.startsWith('data:')) continue
                const d = line.slice(5).trim(); if (!d || d === '[DONE]') { send({ content: '', done: true }); continue }
                try {
                  const chunk = JSON.parse(d)
                  const content = chunk.choices?.[0]?.delta?.content
                  const finished = chunk.choices?.[0]?.finish_reason != null
                  if (content) send({ content, done: false })
                  if (finished) send({ content: '', done: true })
                } catch {}
              }
            }
          }
        } catch (err) { send({ error: err.message }) }
        if (!res.writableEnded) res.end()
      })
      return
    }

    // Fetch live model list from provider using vault key
    if (url.pathname === '/api/models' && req.method === 'GET') {
      corsSpinny(res)
      const provider = url.searchParams.get('provider') || ''
      const MODEL_ENDPOINTS = {
        openai:     'https://api.openai.com/v1/models',
        xai:        'https://api.x.ai/v1/models',
        openrouter: 'https://openrouter.ai/api/v1/models',
      }
      const ANTHROPIC_MODELS = [
        'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20251022', 'claude-opus-4-5',
        'claude-3-5-haiku-20241022', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229',
      ]
      if (provider === 'anthropic') return json(res, { models: ANTHROPIC_MODELS }, 200, corsSpinny)
      const endpoint = MODEL_ENDPOINTS[provider]
      if (!endpoint) return json(res, { error: 'unknown provider', models: [] }, 400, corsSpinny)
      try {
        const vault = new Vault()
        const stored = vault.get(VAULT_NS, provider)
        vault.close()
        const apiKey = stored?.key || ''
        if (!apiKey) return json(res, { error: 'no key', models: [] }, 402, corsSpinny)
        const r = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) })
        if (!r.ok) return json(res, { error: `provider ${r.status}`, models: [] }, 502, corsSpinny)
        const data = await r.json()
        let models = (data.data || []).map(m => m.id)
        if (provider === 'openai') models = models.filter(id => /^(gpt-|o1|o3|o4)/.test(id)).sort()
        if (provider === 'xai') models = models.filter(id => id.startsWith('grok')).sort()
        return json(res, { models }, 200, corsSpinny)
      } catch (err) { return json(res, { error: err.message, models: [] }, 502, corsSpinny) }
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
