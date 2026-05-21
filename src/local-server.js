import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)
const LOCAL_VERSION = (() => { try { return _require('../package.json').version } catch { return '0.0.0' } })()
import { loadState, saveState, generatePairingCode } from './state.js'
import { pairNodeDirect } from './pairing.js'
import { getSystemInfo } from './system-info.js'
import { getLines } from './log-buffer.js'
import { Vault } from './vault.js'
import { exportModelBundle, importModelBundle, importModelBundleFromUrl, getBundleReadStream } from './model-bundles.js'
import {
  captureFeedback,
  completeGmailOAuth,
  configureTelegram,
  deleteGmailCredentials,
  emailMetrics,
  emailStatus,
  executeEmailAction,
  feedbackInsights,
  formatTelegramNotification,
  getGmailCredentials,
  handleTelegramWebhook,
  initGmailOAuth,
  monitorEmails,
  pauseEmailAutomation,
  planEmailAutomation,
  resumeEmailAutomation,
  saveGmailCredentials,
  sendTelegramNotification
} from './email-vertical.js'
import {
  executeInstruction,
  loadPrivacyPolicy,
  memoryStats,
  prepareInstruction,
  readReceipts,
  recordRejectedInstruction,
  savePrivacyPolicy,
} from './instruction-handler.js'

const downloads = new Map() // model -> { status, progress, done, success, startedAt }

const VAULT_NS = 'byok'
const SPINNY_ORIGINS = new Set(['https://spinny.au', 'https://www.spinny.au'])

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

function corsSpinny(res, reqOrigin) {
  const allow = (reqOrigin && SPINNY_ORIGINS.has(reqOrigin)) ? reqOrigin : 'https://spinny.au'
  res.setHeader('Access-Control-Allow-Origin', allow)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
  res.setHeader('Vary', 'Origin')
}

function isTrustedOrigin(req) {
  const origin = req.headers.origin || ''
  return !origin
    || SPINNY_ORIGINS.has(origin)
    || origin.startsWith(`http://localhost:${PORT}`)
    || origin.startsWith(`http://127.0.0.1:${PORT}`)
}

const PORT = 47821
const UI_DIST = join(import.meta.dirname, '..', 'ui', 'dist')
const DASHBOARD_TOKEN = process.env.SPINNY_DASHBOARD_TOKEN || null

function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k) out[k.trim()] = decodeURIComponent(v.join('=').trim())
  }
  return out
}

function isDashboardAuthed(req) {
  if (!DASHBOARD_TOKEN) return true
  const cookies = parseCookies(req.headers.cookie)
  return cookies['spinny_dash'] === DASHBOARD_TOKEN
}

const LOGIN_PAGE = (err = '') => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Spinny — Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#111;border:1px solid #222;border-radius:12px;padding:36px 40px;width:100%;max-width:380px}
  h1{font-size:20px;font-weight:700;margin-bottom:6px;letter-spacing:-.01em}
  p{font-size:13px;color:#666;margin-bottom:24px}
  label{display:block;font-size:12px;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em}
  input{width:100%;background:#0a0a0a;border:1px solid #2a2a2a;color:#e0e0e0;border-radius:7px;padding:10px 14px;font-size:14px;font-family:monospace;outline:none;transition:border .15s}
  input:focus{border-color:#7c5cfc}
  button{width:100%;margin-top:14px;background:#7c5cfc;color:#fff;border:none;border-radius:7px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s}
  button:hover{opacity:.85}
  .err{color:#fc5c5c;font-size:13px;margin-top:12px}
  .logo{font-size:11px;font-family:monospace;color:#444;margin-bottom:20px;letter-spacing:.08em}
</style></head>
<body><div class="card">
  <div class="logo">SPINNY · LOCAL NODE</div>
  <h1>Dashboard access</h1>
  <p>Enter your dashboard token to continue.</p>
  <form method="POST" action="/api/dashboard-login">
    <label for="t">Token</label>
    <input id="t" name="token" type="password" autofocus placeholder="••••••••••••••••" autocomplete="current-password">
    <button type="submit">Unlock</button>
    ${err ? `<div class="err">${err}</div>` : ''}
  </form>
</div></body></html>`

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  const body = await readBody(req)
  try { return JSON.parse(body || '{}') } catch {
    const error = new Error('Invalid request')
    error.status = 400
    error.code = 'invalid_json'
    throw error
  }
}

export function startLocalServer({ getRelayStatus, getRelayError, onPaired, getRelay } = {}) {
  const handler = async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const reqOrigin = req.headers.origin || ''
    // Origin-aware corsSpinny for this specific request — reflects www or bare back correctly
    const corsSpinnyReq = (r) => corsSpinny(r, reqOrigin)

    if (req.method === 'OPTIONS') {
      const p = url.pathname
      const origin = req.headers.origin || '(no origin)'
      const pna = req.headers['access-control-request-private-network']
      if (
        p.startsWith('/api/vault/')
        || p.startsWith('/api/node/')
        || p === '/api/cloud-chat'
        || p === '/api/models'
        || p === '/api/instruction'
        || p.startsWith('/api/email/')
        || p === '/api/memory/stats'
        || p === '/api/privacy'
        || p === '/api/receipts'
      ) {
        console.log(`[preflight] OPTIONS ${p} origin="${origin}" pna=${pna || 'not-requested'}`)
        corsSpinnyReq(res)
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

    // Local privacy firewall configuration. This is the user's own machine
    // setting, so it is intentionally unsigned.
    if (url.pathname === '/api/privacy' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      return json(res, loadPrivacyPolicy(), 200, corsSpinnyReq)
    }

    if (url.pathname === '/api/privacy' && req.method === 'PUT') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const parsed = await readJsonBody(req)
        return json(res, savePrivacyPolicy(parsed), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.code || 'invalid_privacy_policy' }, error.status || 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/receipts' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const limit = parseInt(url.searchParams.get('limit') || '20', 10)
      return json(res, { receipts: readReceipts(limit) }, 200, corsSpinnyReq)
    }

    if (url.pathname === '/api/memory/stats' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      return json(res, memoryStats(), 200, corsSpinnyReq)
    }

    if (url.pathname === '/api/email/status' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      return json(res, emailStatus(), 200, corsSpinnyReq)
    }

    if (url.pathname === '/api/email/metrics' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      return json(res, emailMetrics(), 200, corsSpinnyReq)
    }

    if (url.pathname === '/api/email/pause' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        return json(res, pauseEmailAutomation(await readJsonBody(req)), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/email/resume' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        await readJsonBody(req).catch(() => ({}))
        return json(res, resumeEmailAutomation(), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/email/credentials' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        return json(res, saveGmailCredentials(await readJsonBody(req)), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/email/credentials' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      return json(res, getGmailCredentials(), 200, corsSpinnyReq)
    }

    if (url.pathname === '/api/email/credentials' && req.method === 'DELETE') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      return json(res, deleteGmailCredentials(), 200, corsSpinnyReq)
    }

    if (url.pathname === '/api/email/oauth/init' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        return json(res, initGmailOAuth(await readJsonBody(req)), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/email/oauth/callback' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        return json(res, await completeGmailOAuth(await readJsonBody(req)), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.message }, 400, corsSpinnyReq)
      }
    }

    // Google OAuth redirect — GET with ?code=&state=&email=
    if (url.pathname === '/api/email/oauth/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const accountEmail = url.searchParams.get('email') || url.searchParams.get('login_hint') || 'gmail-account'
      const redirectUri = `http://localhost:${PORT}/api/email/oauth/callback`
      try {
        await completeGmailOAuth({ code, state, redirectUri, accountEmail })
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><body style="font-family:system-ui;background:#0d0d0d;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:48px">✓</div><h2>Gmail connected!</h2><p style="color:#666">You can close this tab and return to Spinny.</p></div></body></html>')
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/html' })
        res.end(`<html><body style="font-family:system-ui;background:#0d0d0d;color:#e0e0e0;padding:40px"><h2>OAuth failed</h2><pre style="color:#ef4444">${error.message}</pre></body></html>`)
      }
      return
    }

    if (url.pathname === '/api/email/plan' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        return json(res, planEmailAutomation(await readJsonBody(req)), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/email/monitor' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        return json(res, await monitorEmails(await readJsonBody(req)), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/email/action' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        return json(res, await executeEmailAction(await readJsonBody(req)), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/email/feedback' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        return json(res, captureFeedback(await readJsonBody(req)), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/email/telegram/preview' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        return json(res, formatTelegramNotification(await readJsonBody(req)), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/email/telegram/configure' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        return json(res, configureTelegram(await readJsonBody(req)), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/email/telegram/send' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        return json(res, await sendTelegramNotification(await readJsonBody(req)), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/email/telegram/webhook' && req.method === 'POST') {
      // No origin check — Telegram sends from their servers (no browser origin header)
      try {
        const body = await readBody(req)
        return json(res, await handleTelegramWebhook(body), 200, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/email/feedback/insights' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      return json(res, feedbackInsights(), 200, corsSpinnyReq)
    }

    // ── Multi-account access management ──────────────────────────────────────

    // GET /api/node/access — returns multiAccount, locked, user lists
    if (url.pathname === '/api/node/access' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const state = loadState()
      return json(res, {
        multiAccount: !!state.multiAccount,
        locked: !!state.locked,
        allowedUsers: state.allowedUsers || [],
        pendingRequests: state.pendingRequests || [],
      }, 200, corsSpinnyReq)
    }

    // PATCH /api/node/access — update multiAccount and/or locked (owner only)
    if (url.pathname === '/api/node/access' && req.method === 'PATCH') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        const state = loadState()
        const next = { ...state }
        if (typeof body.multiAccount === 'boolean') next.multiAccount = body.multiAccount
        if (typeof body.locked === 'boolean') next.locked = body.locked
        saveState(next)
        return json(res, { ok: true, multiAccount: next.multiAccount, locked: next.locked }, 200, corsSpinnyReq)
      } catch (err) { return json(res, { error: err.message }, 400, corsSpinnyReq) }
    }

    // POST /api/node/access/users — owner adds a user by email
    if (url.pathname === '/api/node/access/users' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        const email = (body.email || '').toLowerCase().trim()
        if (!email || !email.includes('@')) return json(res, { error: 'valid email required' }, 400, corsSpinnyReq)
        const state = loadState()
        const existing = (state.allowedUsers || []).some(u => u.email === email)
        if (existing) return json(res, { ok: true, note: 'already in list' }, 200, corsSpinnyReq)
        const allowedUsers = [...(state.allowedUsers || []), { email, addedAt: new Date().toISOString() }]
        // also clear from pending
        const pendingRequests = (state.pendingRequests || []).filter(r => r.email !== email)
        saveState({ ...state, allowedUsers, pendingRequests })
        return json(res, { ok: true, email }, 200, corsSpinnyReq)
      } catch (err) { return json(res, { error: err.message }, 400, corsSpinnyReq) }
    }

    // DELETE /api/node/access/users/:email — owner removes a user
    const accessUserDel = url.pathname.match(/^\/api\/node\/access\/users\/(.+)$/)
    if (accessUserDel && req.method === 'DELETE') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const email = decodeURIComponent(accessUserDel[1]).toLowerCase().trim()
      const state = loadState()
      const allowedUsers = (state.allowedUsers || []).filter(u => u.email !== email)
      saveState({ ...state, allowedUsers })
      return json(res, { ok: true, email }, 200, corsSpinnyReq)
    }

    // POST /api/node/access/request — any user requests access (rate-limited by email)
    if (url.pathname === '/api/node/access/request' && req.method === 'POST') {
      corsSpinnyReq(res)
      try {
        const body = await readJsonBody(req)
        const email = (body.email || '').toLowerCase().trim()
        const message = (body.message || '').slice(0, 200)
        if (!email || !email.includes('@')) return json(res, { error: 'valid email required' }, 400, corsSpinnyReq)
        const state = loadState()
        if (!state.multiAccount) return json(res, { error: 'this node is not accepting new users' }, 403, corsSpinnyReq)
        if (state.locked) return json(res, { error: 'this node is locked — no new accounts can join' }, 403, corsSpinnyReq)
        if ((state.allowedUsers || []).some(u => u.email === email)) return json(res, { ok: true, note: 'already allowed' }, 200, corsSpinnyReq)
        const existing = (state.pendingRequests || []).find(r => r.email === email)
        const pendingRequests = existing
          ? (state.pendingRequests || []).map(r => r.email === email ? { ...r, message, requestedAt: new Date().toISOString() } : r)
          : [...(state.pendingRequests || []), { email, message, requestedAt: new Date().toISOString() }]
        saveState({ ...state, pendingRequests })
        return json(res, { ok: true }, 200, corsSpinnyReq)
      } catch (err) { return json(res, { error: err.message }, 400, corsSpinnyReq) }
    }

    // POST /api/node/access/approve — owner approves or denies a pending request
    if (url.pathname === '/api/node/access/approve' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        const email = (body.email || '').toLowerCase().trim()
        const action = body.action // 'approve' | 'deny'
        if (!email || !['approve', 'deny'].includes(action)) return json(res, { error: 'email and action required' }, 400, corsSpinnyReq)
        const state = loadState()
        const pendingRequests = (state.pendingRequests || []).filter(r => r.email !== email)
        const allowedUsers = action === 'approve'
          ? [...(state.allowedUsers || []).filter(u => u.email !== email), { email, addedAt: new Date().toISOString() }]
          : (state.allowedUsers || [])
        saveState({ ...state, allowedUsers, pendingRequests })
        return json(res, { ok: true, email, action }, 200, corsSpinnyReq)
      } catch (err) { return json(res, { error: err.message }, 400, corsSpinnyReq) }
    }

    // Signed Vercel -> local command lane.
    if (url.pathname === '/api/instruction' && req.method === 'POST') {
      let packet
      let prepared
      try {
        packet = await readJsonBody(req)
        prepared = prepareInstruction(packet)
      } catch (error) {
        const code = error.code || 'instruction_rejected'
        const receipt = error.receipt || recordRejectedInstruction(packet, code)
        return json(res, { error: code, receipt }, error.status || 400, corsSpinnyReq)
      }

      if (prepared.op === 'infer.run') {
        corsSpinnyReq(res)
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
        const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {} }
        try {
          const result = await executeInstruction(prepared, { onStream: send })
          send({ done: true, ...result.body })
        } catch (error) {
          send({ error: error.code || 'instruction_failed', receipt: error.receipt || null })
        }
        if (!res.writableEnded) res.end()
        return
      }

      try {
        const result = await executeInstruction(prepared)
        return json(res, result.body, result.status, corsSpinnyReq)
      } catch (error) {
        return json(res, { error: error.code || 'instruction_failed', receipt: error.receipt || null }, error.status || 500, corsSpinnyReq)
      }
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
          // keep_alive=-1: model stays loaded in RAM indefinitely (no cold-start penalty)
          // think=false: disable qwen3/deepseek chain-of-thought for fast responses
          const isThinkingModel = /qwen3|deepseek-r|qwq/i.test(model)
          const ollamaRes = await fetch('http://localhost:11434/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model, messages, stream: true,
              keep_alive: -1,
              ...(isThinkingModel ? { think: false } : {}),
            }),
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
                const content = chunk.message?.content ?? ''
                send({ content, done: chunk.done ?? false })
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

    // Current pairing token + countdown info
    if (url.pathname === '/pairing/token' && req.method === 'GET') {
      const state = loadState()
      const issuedAt = state.pairingCodeIssuedAt || Date.now()
      const ttl = 60
      const elapsed = Math.floor((Date.now() - issuedAt) / 1000)
      const remaining = Math.max(0, ttl - (elapsed % ttl))
      return json(res, {
        code: state.pairingCode || null,
        issuedAt,
        ttl,
        remaining,
        paired: state.paired,
        maxPairedAccounts: state.maxPairedAccounts || 1,
        pairedCount: state.allowedUsers?.length || (state.paired ? 1 : 0),
      })
    }

    // Admin config — gated by dashboard token
    if (url.pathname === '/admin/config') {
      const adminToken = req.headers['x-admin-token']
      const envToken = process.env.SPINNY_DASHBOARD_TOKEN
      if (!envToken || adminToken !== envToken) return json(res, { error: 'unauthorized' }, 401)
      if (req.method === 'GET') {
        const state = loadState()
        return json(res, {
          maxPairedAccounts: state.maxPairedAccounts || 1,
          multiAccount: state.multiAccount || false,
          allowedUsers: state.allowedUsers || [],
          pairedCount: state.allowedUsers?.length || (state.paired ? 1 : 0),
        })
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const state = loadState()
        const updates = {}
        if (typeof body.maxPairedAccounts === 'number') updates.maxPairedAccounts = Math.max(1, Math.min(50, body.maxPairedAccounts))
        if (typeof body.multiAccount === 'boolean') updates.multiAccount = body.multiAccount
        saveState({ ...state, ...updates })
        return json(res, { ok: true })
      }
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
      // If locked and already has an owner, block new pairings
      if (state.locked && state.accountId && email.toLowerCase().trim() !== state.accountId) {
        res.writeHead(403, corsHeaders)
        return res.end(JSON.stringify({ error: 'This node is locked — no new accounts can be added' }))
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
        return json(res, { keys }, 200, corsSpinnyReq)
      } finally { vault.close() }
    }

    // ── Vault: store a key ────────────────────────────────────────────────
    if (url.pathname === '/api/vault/keys' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => {
        let parsed
        try { parsed = JSON.parse(body) } catch { return json(res, { error: 'Invalid request' }, 400, corsSpinnyReq) }
        const { provider, key } = parsed
        if (!provider || !key) return json(res, { error: 'provider and key required' }, 400, corsSpinnyReq)
        if (!/^[\w-]+$/.test(provider)) return json(res, { error: 'Invalid provider name' }, 400, corsSpinnyReq)
        if (key.length < 8) return json(res, { error: 'Key too short' }, 400, corsSpinnyReq)
        const vault = new Vault()
        try {
          vault.put(VAULT_NS, provider, { key, storedAt: new Date().toISOString() })
          return json(res, { ok: true, provider, preview: maskKey(key) }, 200, corsSpinnyReq)
        } finally { vault.close() }
      })
      return
    }

    // ── Vault: delete a key ───────────────────────────────────────────────
    const vaultDel = url.pathname.match(/^\/api\/vault\/keys\/([\w-]+)$/)
    if (vaultDel && req.method === 'DELETE') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const provider = vaultDel[1]
      const vault = new Vault()
      try {
        vault.db.prepare('DELETE FROM encrypted_items WHERE namespace = ? AND item_key = ?').run(VAULT_NS, provider)
        return json(res, { ok: true, provider }, 200, corsSpinnyReq)
      } finally { vault.close() }
    }

    // ── Cloud chat: use vault key to call AI provider, stream SSE ─────────
    if (url.pathname === '/api/cloud-chat' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', async () => {
        let parsed
        try { parsed = JSON.parse(body) } catch { return json(res, { error: 'Invalid request' }, 400, corsSpinnyReq) }
        const { provider, model, messages } = parsed
        if (!provider || !model || !Array.isArray(messages)) return json(res, { error: 'provider, model and messages required' }, 400, corsSpinnyReq)
        if (!CLOUD_APIS[provider]) return json(res, { error: `Unknown provider: ${provider}` }, 400, corsSpinnyReq)

        const vault = new Vault()
        let apiKey
        try {
          const entry = vault.get(VAULT_NS, provider)
          apiKey = entry?.key
        } finally { vault.close() }
        if (!apiKey) return json(res, { error: `No vault key stored for: ${provider}` }, 401, corsSpinnyReq)

        corsSpinnyReq(res)
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
      corsSpinnyReq(res)
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
      if (provider === 'anthropic') return json(res, { models: ANTHROPIC_MODELS }, 200, corsSpinnyReq)
      const endpoint = MODEL_ENDPOINTS[provider]
      if (!endpoint) return json(res, { error: 'unknown provider', models: [] }, 400, corsSpinnyReq)
      try {
        const vault = new Vault()
        const stored = vault.get(VAULT_NS, provider)
        vault.close()
        const apiKey = stored?.key || ''
        if (!apiKey) return json(res, { error: 'no key', models: [] }, 402, corsSpinnyReq)
        const r = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) })
        if (!r.ok) return json(res, { error: `provider ${r.status}`, models: [] }, 502, corsSpinnyReq)
        const data = await r.json()
        let models = (data.data || []).map(m => m.id)
        if (provider === 'openai') models = models.filter(id => /^(gpt-|o1|o3|o4)/.test(id)).sort()
        if (provider === 'xai') models = models.filter(id => id.startsWith('grok')).sort()
        return json(res, { models }, 200, corsSpinnyReq)
      } catch (err) { return json(res, { error: err.message, models: [] }, 502, corsSpinnyReq) }
    }

    // Dashboard token login
    if (url.pathname === '/api/dashboard-login' && req.method === 'POST') {
      const body = await readBody(req)
      const params = new URLSearchParams(body)
      const token = params.get('token') || ''
      if (DASHBOARD_TOKEN && token !== DASHBOARD_TOKEN) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        return res.end(LOGIN_PAGE('Invalid token — try again'))
      }
      const maxAge = 60 * 60 * 24 * 30 // 30 days
      res.writeHead(302, {
        'Set-Cookie': `spinny_dash=${DASHBOARD_TOKEN || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
        'Location': '/'
      })
      return res.end()
    }

    // Serve React app static files — require dashboard token if set
    if (req.method === 'GET') {
      if (DASHBOARD_TOKEN && !isDashboardAuthed(req) && !url.pathname.startsWith('/api/')) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        return res.end(LOGIN_PAGE())
      }
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname
      const filePath = join(UI_DIST, pathname)
      return serveStatic(res, filePath)
    }

    res.writeHead(404)
    res.end()
  }

  const bindHost = process.env.SPINNY_BIND_HOST || '0.0.0.0'
  const tlsCert = process.env.SPINNY_TLS_CERT
  const tlsKey  = process.env.SPINNY_TLS_KEY
  const tlsHost = process.env.SPINNY_TLS_HOSTNAME

  let server
  if (tlsCert && tlsKey && existsSync(tlsCert) && existsSync(tlsKey)) {
    try {
      server = createHttpsServer({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }, handler)
      server.listen(PORT, bindHost, () => {
        console.log(`Spinny local panel: https://${tlsHost || 'localhost'}:${PORT}`)
      })
    } catch (e) {
      console.warn('[tls] Failed to load certs, falling back to HTTP:', e.message)
      server = createServer(handler)
      server.listen(PORT, bindHost, () => console.log(`Spinny local panel: http://localhost:${PORT}`))
    }
  } else {
    server = createServer(handler)
    server.listen(PORT, bindHost, () => console.log(`Spinny local panel: http://localhost:${PORT}`))
  }
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') console.error('Local server error:', err.message)
  })
  return server
}
