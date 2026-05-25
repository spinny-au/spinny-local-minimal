import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)
const LOCAL_VERSION = (() => { try { return _require('../package.json').version } catch { return '0.0.0' } })()

// ── Update state (module-level, survives the update process until restart) ─────
const REPO_ROOT = join(import.meta.dirname, '..')
const UPDATE_STATE_PATH = join(REPO_ROOT, 'spinny-update-state.json')
let _prevCommitHash = null   // set before every update; used for rollback
let _updateCheckCache = null // { result, fetchedAt }
const UPDATE_CACHE_TTL = 5 * 60 * 1000

function localCommitHash() {
  try { return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, windowsHide: true }).toString().trim() } catch { return null }
}

function readUpdateState() {
  try {
    if (!existsSync(UPDATE_STATE_PATH)) return {}
    return JSON.parse(readFileSync(UPDATE_STATE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function writeUpdateState(patch) {
  const current = readUpdateState()
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
  try { writeFileSync(UPDATE_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8') } catch {}
  return next
}

async function fetchRemoteCommit() {
  const r = await fetch('https://api.github.com/repos/spinny-au/spinny-local-minimal/commits/main', {
    headers: { 'User-Agent': 'spinny-local-minimal', Accept: 'application/vnd.github.v3+json' }
  })
  if (!r.ok) throw new Error(`GitHub API ${r.status}`)
  const d = await r.json()
  return { sha: d.sha, message: (d.commit?.message || '').split('\n')[0], date: d.commit?.author?.date || null }
}

function quoteCmdArg(arg) {
  const text = String(arg)
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

function resolveSpawnCommand(cmd, args) {
  if (process.platform !== 'win32') return { cmd, args }
  if (cmd === 'git') return { cmd: 'git.exe', args }
  if (cmd === 'npm') {
    const candidates = [
      process.env.npm_execpath && process.env.npm_execpath.endsWith('.js') ? process.env.npm_execpath : null,
      join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].filter(Boolean)
    const npmCli = candidates.find((p) => existsSync(p))
    if (npmCli) return { cmd: process.execPath, args: [npmCli, ...args] }
    return {
      cmd: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', ['npm', ...args].map(quoteCmdArg).join(' ')],
    }
  }
  return { cmd, args }
}

function spawnStream(cmd, args, cwd, onLine) {
  return new Promise(resolve => {
    const resolved = resolveSpawnCommand(cmd, args)
    const p = spawn(resolved.cmd, resolved.args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    captureChildStderr(p, cmd)
    const onChunk = chunk => chunk.toString().split('\n').filter(l => l.trim()).forEach(onLine)
    let settled = false
    p.stdout.on('data', onChunk)
    p.stderr.on('data', onChunk)
    p.on('error', err => {
      onLine(`${cmd} failed: ${err.message}`)
      if (!settled) { settled = true; resolve(1) }
    })
    p.on('close', code => {
      if (!settled) { settled = true; resolve(code ?? 1) }
    })
  })
}

function restartProcess() {
  if (process.platform === 'win32') {
    // /end first so Task Scheduler doesn't treat the task as already-running
    // (state can linger briefly after the process exits). Then /run after exit.
    const taskName = 'SpinnyLocalNode'
    const doRestart = () => {
      spawn('schtasks.exe', ['/end', '/tn', taskName], {
        stdio: 'ignore', windowsHide: true,
      }).on('close', () => {
        setTimeout(() => {
          spawn('schtasks.exe', ['/run', '/tn', taskName], {
            detached: true, stdio: 'ignore', windowsHide: true,
          }).unref()
        }, 1500)
      })
    }
    doRestart()
  } else {
    spawn(process.execPath, process.argv.slice(1), {
      detached: true, stdio: 'ignore', cwd: REPO_ROOT, env: process.env,
    }).unref()
  }
  setTimeout(() => process.exit(0), 8000)
}

function startUpdateWorker(mode, target = '') {
  const child = spawn(process.execPath, [
    join(REPO_ROOT, 'scripts', 'update-worker.mjs'),
    REPO_ROOT,
    mode,
    target || '',
  ], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  })
  child.unref()
  const signalPath = join(REPO_ROOT, '.update-signal')
  let restarted = false
  let attempts = 0
  const maxAttempts = 60
  const poll = setInterval(() => {
    attempts++
    if (existsSync(signalPath)) {
      clearInterval(poll)
      try {
        const signal = JSON.parse(readFileSync(signalPath, 'utf8'))
        logEvent('update', 'signal', `status=${signal.status} mode=${signal.mode} error=${signal.error || 'none'}`)
        writeUpdateState({
          mode: signal.mode,
          stage: signal.status === 'rolled_back' ? 'rolled-back' : signal.status,
          signalStatus: signal.status,
          error: signal.error || null,
          signalledAt: signal.timestamp || new Date().toISOString(),
        })
      } catch {}
      try { rmSync(signalPath) } catch {}
      restarted = true
      restartProcess()
    } else if (attempts >= maxAttempts) {
      clearInterval(poll)
      logEvent('update', 'timeout', 'No signal after 60s; restarting anyway')
      restarted = true
      restartProcess()
    }
  }, 1000)
  setTimeout(() => {
    if (!restarted) process.exit(0)
  }, 120000)
}

function openExternal(target) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      return true
    }
    if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
      return true
    }
    spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

function tailscaleInstallUrl() {
  if (process.platform === 'win32') return 'https://tailscale.com/download/windows'
  if (process.platform === 'darwin') return 'https://tailscale.com/download/mac'
  return 'https://tailscale.com/download'
}

function tailscaleStatus() {
  const supported = process.platform === 'win32' || process.platform === 'darwin'
  let installed = false
  let ip = null
  let status = null
  let error = null
  try {
    execSync('tailscale version', { timeout: 3000, stdio: 'pipe', windowsHide: true })
    installed = true
  } catch (err) {
    error = err.message
  }
  if (installed) {
    try {
      const out = execSync('tailscale ip --4', { timeout: 3000, stdio: 'pipe', windowsHide: true }).toString().trim()
      if (/^\d+\.\d+\.\d+\.\d+$/.test(out)) ip = out
    } catch {}
    try {
      const raw = execSync('tailscale status --json', { timeout: 5000, stdio: 'pipe', windowsHide: true }).toString()
      const parsed = JSON.parse(raw)
      status = {
        backendState: parsed.BackendState || null,
        selfName: parsed.Self?.DNSName || parsed.Self?.HostName || null,
        online: Boolean(parsed.Self?.Online),
      }
    } catch {}
  }
  return {
    supported,
    platform: process.platform,
    installed,
    ip,
    nodeUrl: ip ? `http://${ip}:${PORT}` : null,
    status,
    installUrl: tailscaleInstallUrl(),
    error: installed ? null : error,
  }
}

function startTailscaleSetup() {
  const info = tailscaleStatus()
  if (!info.supported) return { ok: false, error: 'Tailscale setup is only offered here for Windows and macOS.' }
  if (!info.installed) {
    openExternal(info.installUrl)
    return { ok: true, action: 'opened-install-page', ...info }
  }
  try {
    const child = spawn('tailscale', ['up'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return { ok: true, action: 'started-tailscale-up', ...info }
  } catch (err) {
    return { ok: false, error: err.message, ...info }
  }
}

async function advertisePairingCode(state, code) {
  const controlUrl = state.controlUrl || process.env.SPINNY_CONTROL_URL || 'https://spinny.au'
  const identity = ensureNodeIdentity()
  const response = await fetch(`${controlUrl.replace(/\/$/, '')}/api/spinny/pairing/advertise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingCode: code, nodeId: state.nodeId, nodePublicKey: identity.publicKeyDer }),
    signal: AbortSignal.timeout(10000),
  })
  const body = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, body }
}

async function regeneratePairingCode() {
  const current = saveState(loadState())
  const code = generatePairingCode()
  const next = saveState({ ...current, pairingCode: code, pairingCodeIssuedAt: Date.now() })
  const advertised = await advertisePairingCode(next, code).catch((err) => ({
    ok: false,
    status: 0,
    body: { error: err.message },
  }))
  return {
    code,
    issuedAt: next.pairingCodeIssuedAt,
    ttl: 600,
    remaining: 600,
    paired: next.paired,
    maxPairedAccounts: next.maxPairedAccounts || 1,
    pairedCount: next.allowedUsers?.length || (next.paired ? 1 : 0),
    advertised,
  }
}
import { loadState, saveState, generatePairingCode } from './state.js'
import { ensureNodeIdentity } from './identity.js'
import { pairNodeDirect, requestPairing } from './pairing.js'
import { getSystemInfo } from './system-info.js'
import { getLines } from './log-buffer.js'
import { captureChildStderr, logEvent } from './log-streamer.js'
import { Vault } from './vault.js'
import { LlmManager, classifyProviderError, estimateTokens, normalizeProviderId } from './llm-manager.js'
import { MemoryLayer } from './memory-layer.js'
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
import {
  readFile, writeFile, patchFile, listDir,
  gitStatus, gitBranch, gitCommit, gitPush,
  gitCreateRepo, gitClone, gitCreatePR,
  npmRun, registerPreview, removePreview, resolvePreviewDist, getPreviewUrl,
} from './tools.js'
import {
  selfcoderPlan, selfcoderApprove, selfcoderStart,
  selfcoderStatus, selfcoderReject,
} from './selfcoder.js'
import { attestAndSend } from './integrity.js'
import { runAgent } from './agent.js'

const downloads = new Map() // model -> { status, progress, done, success, startedAt }

const VAULT_NS = 'byok'
const SPINNY_ORIGINS = new Set(['https://spinny.au', 'https://www.spinny.au'])

const CLOUD_APIS = {
  openai:      { url: 'https://api.openai.com/v1/chat/completions',       format: 'openai'    },
  xai:         { url: 'https://api.x.ai/v1/chat/completions',             format: 'openai'    },
  openrouter:  { url: 'https://openrouter.ai/api/v1/chat/completions',    format: 'openai'    },
  anthropic:   { url: 'https://api.anthropic.com/v1/messages',            format: 'anthropic' },
}

async function streamManagedProvider({ manager, providerRecord, apiKey, model, messages, send }) {
  const started = Date.now()
  const inputTokens = estimateTokens(messages)
  let outputText = ''
  const chosenModel = model || providerRecord.models?.[0]
  if (!chosenModel) throw new Error(`No model configured for ${providerRecord.provider}`)

  const response = await fetchProvider(providerRecord, apiKey, chosenModel, messages)
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    const info = classifyProviderError(response.status, response.headers, text)
    manager.recordError(providerRecord.provider, { ...info, httpStatus: response.status, body: text.slice(0, 500) })
    const err = new Error(`${providerRecord.provider} ${response.status}: ${info.code}`)
    err.providerError = info
    throw err
  }

  const reader = response.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const piece = parseProviderStreamLine(providerRecord, line)
      if (piece.done) {
        send({ content: '', done: true })
        continue
      }
      if (piece.content) {
        outputText += piece.content
        send({ content: piece.content, done: false })
      }
    }
  }
  const outputTokens = estimateTokens(outputText)
  const costUsd = estimateCost(providerRecord, inputTokens, outputTokens)
  manager.recordSuccess(providerRecord.provider, {
    inputTokens,
    outputTokens,
    latencyMs: Date.now() - started,
    headers: response.headers,
    costUsd,
  })
  send({ content: '', done: true, provider: providerRecord.provider, model: chosenModel })
  return { provider: providerRecord.provider, model: chosenModel, inputTokens, outputTokens, costUsd, outputText }
}

function fetchProvider(provider, apiKey, model, messages) {
  if (provider.format === 'anthropic') {
    return fetch(provider.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, messages, max_tokens: 8096, stream: true }),
      signal: AbortSignal.timeout(90_000),
    })
  }
  if (provider.format === 'gemini') {
    const endpoint = provider.endpoint.replace('{model}', encodeURIComponent(model))
    const system = messages.find(m => m?.role === 'system')?.content || ''
    const contents = messages
      .filter(m => m?.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(m.content || '') }],
      }))
    return fetch(`${endpoint}?alt=sse&key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: String(system) }] } } : {}),
        contents,
      }),
      signal: AbortSignal.timeout(90_000),
    })
  }
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  if (provider.provider === 'openrouter') {
    headers['http-referer'] = 'https://spinny.au'
    headers['x-title'] = 'Spinny'
  }
  return fetch(provider.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, stream: true }),
    signal: AbortSignal.timeout(90_000),
  })
}

function parseProviderStreamLine(provider, line) {
  if (!line.startsWith('data:')) return {}
  const data = line.slice(5).trim()
  if (!data || data === '[DONE]') return { done: true }
  try {
    const chunk = JSON.parse(data)
    if (provider.format === 'anthropic') {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) return { content: chunk.delta.text }
      if (chunk.type === 'message_stop') return { done: true }
      return {}
    }
    if (provider.format === 'gemini') {
      const content = chunk.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''
      return content ? { content } : {}
    }
    const content = chunk.choices?.[0]?.delta?.content
    const finished = chunk.choices?.[0]?.finish_reason != null
    return { content, done: finished }
  } catch {
    return {}
  }
}

function estimateCost(provider, inputTokens, outputTokens) {
  const pricing = provider.pricing || {}
  return Number((((inputTokens / 1_000_000) * (pricing.inputPerMTok || 0)) + ((outputTokens / 1_000_000) * (pricing.outputPerMTok || 0))).toFixed(6))
}

function maskKey(key) {
  if (!key || key.length < 8) return '****'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
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
const DASHBOARD_TOKEN = (process.env.SPINNY_DASHBOARD_TOKEN || '').trim() || null
const NODE_NAME = (process.env.SPINNY_NODE_NAME || '').trim() || null

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
    if (url.pathname !== '/health') logEvent('info', 'http', url.pathname, `${req.method} ${url.pathname}`)
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
        || p.startsWith('/api/pairing/')
        || p.startsWith('/api/email/')
        || p === '/api/memory'
        || p.startsWith('/api/memory/')
        || p === '/api/memory/stats'
        || p === '/api/privacy'
        || p === '/api/receipts'
        || p === '/api/tools'
        || p.startsWith('/api/tools/')
        || p === '/api/agent'
        || p.startsWith('/api/selfcoder')
        || p.startsWith('/preview/')
      ) {
        console.log(`[preflight] OPTIONS ${p} origin="${origin}" pna=${pna || 'not-requested'}`)
        corsSpinnyReq(res)
      } else cors(res)
      res.writeHead(204); return res.end()
    }

    // Health (used by spinny.au browser fetch) — must respond instantly, no heavy calls
    if (url.pathname === '/health') {
      const state = loadState()
      const serveUrl = process.env.SPINNY_SERVE_URL || null
      return json(res, { ok: true, nodeId: state.nodeId, paired: state.paired, serveUrl, nodeName: NODE_NAME })
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

    // Browser-assisted relay pairing finalization. spinny.au claims the code in
    // Neon, then sends the short-lived relay session back to this localhost node
    // so the machine itself can persist paired=true immediately.
    if (url.pathname === '/api/pairing/finalize' && req.method === 'POST') {
      corsSpinnyReq(res)
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        const state = saveState(loadState())
        const nodeId = String(body.nodeId || '')
        const accountEmail = String(body.accountEmail || '').toLowerCase().trim()
        const relaySessionToken = String(body.relaySessionToken || '')
        const relaySessionExpiresAt = String(body.relaySessionExpiresAt || '')
        if (!nodeId || nodeId !== state.nodeId) return json(res, { error: 'nodeId mismatch' }, 400, corsSpinnyReq)
        if (!accountEmail || !accountEmail.includes('@')) return json(res, { error: 'valid accountEmail required' }, 400, corsSpinnyReq)
        if (!relaySessionToken || !relaySessionExpiresAt) return json(res, { error: 'relay session required' }, 400, corsSpinnyReq)

        const identity = ensureNodeIdentity()
        const existingUsers = Array.isArray(state.allowedUsers) ? state.allowedUsers : []
        const hasUser = existingUsers.some(u => u?.email === accountEmail)
        const next = saveState({
          ...state,
          paired: true,
          accountId: accountEmail,
          pairedAt: new Date().toISOString(),
          relaySessionToken,
          relaySessionExpiresAt,
          nodePublicKey: identity.publicKeyDer,
          controlPlanePublicKey: body.controlPlanePublicKey || null,
          relayUrl: body.relayUrl || null,
          controlUrl: body.controlUrl || process.env.SPINNY_CONTROL_URL || 'https://spinny.au',
          allowedUsers: hasUser
            ? existingUsers
            : [{ email: accountEmail, role: existingUsers.length ? 'member' : 'owner', addedAt: new Date().toISOString() }, ...existingUsers],
        })
        onPaired?.(next)
        return json(res, { ok: true, nodeId: next.nodeId, paired: true }, 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message || 'finalize failed' }, err.status || 400, corsSpinnyReq)
      }
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
      const memory = new MemoryLayer()
      try {
        return json(res, { encryptedVault: memory.stats(), apprenticeship: memoryStats() }, 200, corsSpinnyReq)
      } finally { memory.close() }
    }

    if (url.pathname === '/api/memory' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const category = url.searchParams.get('category') || 'pinned'
      const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)))
      const memory = new MemoryLayer()
      try {
        return json(res, { category, items: memory.list(category, limit) }, 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      } finally { memory.close() }
    }

    if (url.pathname === '/api/memory/prompt-context' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const memory = new MemoryLayer()
      try {
        return json(res, {
          context: memory.buildPromptContext({
            tier: url.searchParams.get('tier') || 'guru',
            tokenBudget: parseInt(url.searchParams.get('tokenBudget') || '3000', 10),
          }),
        }, 200, corsSpinnyReq)
      } finally { memory.close() }
    }

    if (url.pathname === '/api/memory/search' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const category = url.searchParams.get('category') || 'conversation'
      const query = url.searchParams.get('q') || ''
      const memory = new MemoryLayer()
      try {
        return json(res, { category, query, results: memory.search(category, query) }, 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      } finally { memory.close() }
    }

    if (url.pathname === '/api/memory/facts' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const memory = new MemoryLayer()
      try {
        return json(res, { facts: memory.search('conversation', url.searchParams.get('q') || 'fact', 100) }, 200, corsSpinnyReq)
      } finally { memory.close() }
    }

    if (url.pathname === '/api/memory/facts' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const parsed = await readJsonBody(req)
        const text = String(parsed.text || '').trim()
        if (!text) return json(res, { error: 'text required' }, 400, corsSpinnyReq)
        const memory = new MemoryLayer()
        try {
          const entry = parsed.pinned ? memory.pin(text) : memory.rememberFact(text, parsed.category || 'general')
          return json(res, { ok: true, entry: { key: entry.key, category: entry.category, updatedAt: entry.updatedAt } }, 200, corsSpinnyReq)
        } finally { memory.close() }
      } catch (err) {
        return json(res, { error: err.message }, err.status || 400, corsSpinnyReq)
      }
    }

    const memoryDelete = url.pathname.match(/^\/api\/memory\/([a-z0-9_:-]+)\/([^/]+)$/i)
    if (memoryDelete && req.method === 'DELETE') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const memory = new MemoryLayer()
      try {
        memory.delete(memoryDelete[1], decodeURIComponent(memoryDelete[2]))
        return json(res, { ok: true }, 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      } finally { memory.close() }
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

        const proc = captureChildStderr(spawn('ollama', ['pull', model], { stdio: ['ignore', 'pipe', 'pipe'] }), 'ollama.pull')
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
        const memory = new MemoryLayer()
        const promptContext = memory.buildPromptContext({ tier: 'local', tokenBudget: 1800 })
        const outboundMessages = promptContext
          ? [{ role: 'system', content: promptContext }, ...messages]
          : messages
        let assistantText = ''
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
              model, messages: outboundMessages, stream: true,
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
                if (content) assistantText += content
                send({ content, done: chunk.done ?? false })
              } catch {}
            }
          }
          const lastUser = [...messages].reverse().find(m => m?.role === 'user')?.content || ''
          if (lastUser || assistantText) {
            memory.write('conversation', `turn:${Date.now()}`, {
              user: String(lastUser).slice(0, 8000),
              assistant: assistantText.slice(0, 12000),
              model,
              at: new Date().toISOString(),
            }, { syncable: false })
            memory.write('working', `recent:${Date.now()}`, {
              summary: `Local chat with ${model}: ${String(lastUser).slice(0, 240)}`,
              at: new Date().toISOString(),
            }, { syncable: true })
          }
        } catch (err) {
          send({ error: err.message })
        } finally {
          memory.close()
        }
        res.end()
      })
      return
    }

    // Pairing token — dashboard auth required
    if (url.pathname === '/pairing/token' && req.method === 'GET') {
      if (!isDashboardAuthed(req)) return json(res, { error: 'unauthorized' }, 401)
      const state = loadState()
      const issuedAt = state.pairingCodeIssuedAt || Date.now()
      const ttl = 600
      const elapsed = Math.floor((Date.now() - issuedAt) / 1000)
      const remaining = Math.max(0, ttl - (elapsed % ttl))
      return json(res, {
        code: state.pairingCode || null,
        issuedAt, ttl, remaining,
        paired: state.paired,
        maxPairedAccounts: state.maxPairedAccounts || 1,
        pairedCount: state.allowedUsers?.length || (state.paired ? 1 : 0),
      })
    }

    if (url.pathname === '/pairing/token/regenerate' && req.method === 'POST') {
      if (!isDashboardAuthed(req)) return json(res, { error: 'unauthorized' }, 401)
      const result = await regeneratePairingCode()
      return json(res, result, result.advertised?.ok ? 200 : 502)
    }

    if (url.pathname === '/pairing/request' && req.method === 'POST') {
      if (!isDashboardAuthed(req)) return json(res, { error: 'unauthorized' }, 401)
      try {
        const body = await readJsonBody(req)
        const email = String(body.email || body.targetEmail || '').toLowerCase().trim()
        const result = await requestPairing({ targetEmail: email })
        return json(res, result)
      } catch (err) {
        return json(res, { error: err.message || 'pairing request failed' }, err.status || 400)
      }
    }

    // Admin config — dashboard auth required
    if (url.pathname === '/admin/config') {
      if (!isDashboardAuthed(req)) return json(res, { error: 'unauthorized' }, 401)
      if (req.method === 'GET') {
        const state = loadState()
        return json(res, {
          maxPairedAccounts: state.maxPairedAccounts || 1,
          multiAccount: state.multiAccount || false,
          locked: state.locked || false,
          allowedUsers: state.allowedUsers || [],
          pairedCount: state.allowedUsers?.length || (state.paired ? 1 : 0),
          paired: state.paired,
          verticals: state.verticals || { selfcoder: { enabled: false } },
        })
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const state = loadState()
        const updates = {}
        if (typeof body.maxPairedAccounts === 'number') updates.maxPairedAccounts = Math.max(1, Math.min(50, body.maxPairedAccounts))
        if (typeof body.multiAccount === 'boolean') updates.multiAccount = body.multiAccount
        if (typeof body.locked === 'boolean') updates.locked = body.locked
        if (body.verticals && typeof body.verticals === 'object') {
          updates.verticals = { ...(state.verticals || {}), ...body.verticals }
          for (const [key, val] of Object.entries(updates.verticals)) {
            if (val && typeof val === 'object' && typeof val.enabled !== 'boolean') {
              updates.verticals[key] = { enabled: false }
            }
          }
        }
        const next = saveState({ ...state, ...updates })
        return json(res, {
          maxPairedAccounts: next.maxPairedAccounts || 1,
          multiAccount: next.multiAccount || false,
          locked: next.locked || false,
          allowedUsers: next.allowedUsers || [],
          pairedCount: next.allowedUsers?.length || (next.paired ? 1 : 0),
          paired: next.paired,
          verticals: next.verticals || { selfcoder: { enabled: false } },
        })
      }
    }

    // Tailscale setup/status — dashboard auth required
    if (url.pathname === '/admin/tailscale' && req.method === 'GET') {
      if (!isDashboardAuthed(req)) return json(res, { error: 'unauthorized' }, 401)
      return json(res, tailscaleStatus())
    }

    if (url.pathname === '/admin/tailscale/connect' && req.method === 'POST') {
      if (!isDashboardAuthed(req)) return json(res, { error: 'unauthorized' }, 401)
      const result = startTailscaleSetup()
      return json(res, result, result.ok ? 200 : 400)
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

    // Check for updates — compare git commit hashes, cached 5 min
    if (url.pathname === '/api/update/check' && req.method === 'GET') {
      const now = Date.now()
      const bust = url.searchParams.has('bust')
      if (!bust && _updateCheckCache && (now - _updateCheckCache.fetchedAt) < UPDATE_CACHE_TTL) {
        return json(res, _updateCheckCache.result)
      }
      try {
        const localHash = localCommitHash()
        const remote = await fetchRemoteCommit()
        const updateAvailable = !!(localHash && remote.sha && localHash !== remote.sha)
        const result = {
          updateAvailable,
          localHash: localHash ? localHash.slice(0, 8) : null,
          remoteHash: remote.sha ? remote.sha.slice(0, 8) : null,
          remoteMessage: remote.message,
          remoteDate: remote.date,
          localVersion: LOCAL_VERSION,
        }
        _updateCheckCache = { result, fetchedAt: now }
        return json(res, result)
      } catch (err) {
        return json(res, { updateAvailable: false, localVersion: LOCAL_VERSION, error: err.message })
      }
    }

    // Apply update — fetch + reset --hard + npm install + auto-rollback on failure, then restart
    if (url.pathname === '/api/update/status' && req.method === 'GET') {
      return json(res, {
        ...readUpdateState(),
        currentCommit: localCommitHash(),
        localVersion: LOCAL_VERSION,
      })
    }

    if (url.pathname === '/api/update/apply' && req.method === 'POST') {
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
      const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {} }

      const savedHash = localCommitHash()
      _prevCommitHash = savedHash
      _updateCheckCache = null // invalidate cache
      writeUpdateState({
        mode: 'apply',
        stage: 'queued',
        previousCommit: savedHash || null,
        currentCommit: savedHash || null,
        requestedAt: new Date().toISOString(),
        error: null,
      })

      try {
        send({ status: 'Starting hidden background updater. The dashboard will be back soon.' })
        send({ done: true, success: true, restarting: true })
        res.end()
        startUpdateWorker('apply', savedHash || '')
      } catch (err) {
        send({ done: true, success: false, error: err.message })
        res.end()
      }
      return
    }

    // Rollback to the commit saved before the last update
    if (url.pathname === '/api/update/rollback' && req.method === 'POST') {
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
      const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {} }

      const saved = readUpdateState()
      const target = _prevCommitHash || saved.previousCommit || saved.lastGoodCommit
      if (!target) {
        send({ done: true, success: false, error: 'No previous version recorded — restart the node to restore.' })
        return res.end()
      }

      _updateCheckCache = null
      writeUpdateState({
        mode: 'rollback',
        stage: 'queued',
        previousCommit: target,
        requestedAt: new Date().toISOString(),
        error: null,
      })
      send({ status: `Starting hidden rollback to ${target.slice(0, 8)}. The dashboard will be back soon.` })
      try {
        send({ done: true, success: true, restarting: true })
        res.end()
        startUpdateWorker('rollback', target)
      } catch (err) {
        send({ done: true, success: false, error: err.message })
        res.end()
      }
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
        const provider = normalizeProviderId(parsed.provider)
        const { key } = parsed
        if (!provider || !key) return json(res, { error: 'provider and key required' }, 400, corsSpinnyReq)
        if (!/^[\w-]+$/.test(provider)) return json(res, { error: 'Invalid provider name' }, 400, corsSpinnyReq)
        if (key.length < 8) return json(res, { error: 'Key too short' }, 400, corsSpinnyReq)
        const manager = new LlmManager()
        try {
          manager.vault.put(VAULT_NS, provider, { key, storedAt: new Date().toISOString() })
          manager.upsertProvider(provider, parsed.metadata || {})
          return json(res, { ok: true, provider, preview: maskKey(key) }, 200, corsSpinnyReq)
        } finally { manager.close() }
      })
      return
    }

    // ── Vault: delete a key ───────────────────────────────────────────────
    const vaultDel = url.pathname.match(/^\/api\/vault\/keys\/([\w-]+)$/)
    if (vaultDel && req.method === 'DELETE') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const provider = normalizeProviderId(vaultDel[1])
      const vault = new Vault()
      try {
        vault.db.prepare('DELETE FROM encrypted_items WHERE namespace = ? AND item_key = ?').run(VAULT_NS, provider)
        return json(res, { ok: true, provider }, 200, corsSpinnyReq)
      } finally { vault.close() }
    }

    // ── Cloud chat: use vault key to call AI provider, stream SSE ─────────
    if (url.pathname === '/api/vault/status' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const manager = new LlmManager()
      try {
        return json(res, manager.status(), 200, corsSpinnyReq)
      } finally { manager.close() }
    }

    if (url.pathname === '/api/vault/providers' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const manager = new LlmManager()
      try {
        return json(res, { providers: manager.status().providers, routing: manager.config() }, 200, corsSpinnyReq)
      } finally { manager.close() }
    }

    if (url.pathname === '/api/vault/providers' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const parsed = await readJsonBody(req)
        const provider = normalizeProviderId(parsed.provider)
        if (!provider || !/^[\w-]+$/.test(provider)) return json(res, { error: 'valid provider required' }, 400, corsSpinnyReq)
        const { key, provider: _provider, ...patch } = parsed
        const manager = new LlmManager()
        try {
          if (key) manager.vault.put(VAULT_NS, provider, { key: String(key), storedAt: new Date().toISOString() })
          const record = manager.upsertProvider(provider, patch)
          return json(res, { ok: true, provider, record }, 200, corsSpinnyReq)
        } finally { manager.close() }
      } catch (err) {
        return json(res, { error: err.message }, err.status || 400, corsSpinnyReq)
      }
    }

    const vaultProviderAction = url.pathname.match(/^\/api\/vault\/providers\/([\w-]+)\/(pause|resume|limits)$/)
    if (vaultProviderAction) {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const manager = new LlmManager()
      const provider = normalizeProviderId(vaultProviderAction[1])
      const action = vaultProviderAction[2]
      try {
        if (req.method === 'GET' && action === 'limits') {
          const record = manager.registry().find(p => p.provider === provider)
          if (!record) return json(res, { error: 'provider not found' }, 404, corsSpinnyReq)
          return json(res, { provider, limits: record.limits, usage: manager.usage(provider) }, 200, corsSpinnyReq)
        }
        if (req.method !== 'POST') return json(res, { error: 'method not allowed' }, 405, corsSpinnyReq)
        const record = manager.pauseProvider(provider, action === 'pause')
        manager.event(`provider.${action}`, { provider })
        return json(res, { ok: true, provider, record }, 200, corsSpinnyReq)
      } finally { manager.close() }
    }

    if (url.pathname === '/api/vault/use' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const parsed = await readJsonBody(req).catch(() => ({}))
      const provider = normalizeProviderId(parsed.provider)
      const manager = new LlmManager()
      try {
        const config = manager.saveConfig({ forcedProvider: provider || null, rotationEnabled: !provider ? true : manager.config().rotationEnabled })
        manager.event(provider ? 'routing.forced' : 'routing.auto', { provider: provider || null })
        return json(res, { ok: true, routing: config }, 200, corsSpinnyReq)
      } finally { manager.close() }
    }

    if (url.pathname === '/api/vault/auto' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      const manager = new LlmManager()
      try {
        const config = manager.saveConfig({ forcedProvider: null, rotationEnabled: true })
        manager.event('routing.auto', {})
        return json(res, { ok: true, routing: config }, 200, corsSpinnyReq)
      } finally { manager.close() }
    }

    if (url.pathname === '/api/vault/priority' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const parsed = await readJsonBody(req)
        const provider = normalizeProviderId(parsed.provider)
        const tier = String(parsed.tier || '').toLowerCase()
        const taskType = String(parsed.taskType || 'reasoning').toLowerCase()
        const position = Math.max(1, parseInt(parsed.position || '1', 10))
        if (!provider || !['core', 'guru', 'fenrir'].includes(tier)) return json(res, { error: 'provider and tier required' }, 400, corsSpinnyReq)
        const manager = new LlmManager()
        try {
          const current = manager.config()
          const group = [...(current.priority?.[tier]?.[taskType] || [])].filter(p => p !== provider)
          group.splice(position - 1, 0, provider)
          const priority = { [tier]: { ...(current.priority?.[tier] || {}), [taskType]: group } }
          const routing = manager.saveConfig({ priority })
          manager.event('routing.priority', { provider, tier, taskType, position })
          return json(res, { ok: true, routing }, 200, corsSpinnyReq)
        } finally { manager.close() }
      } catch (err) {
        return json(res, { error: err.message }, err.status || 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/cloud-chat' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      let parsed
      try { parsed = await readJsonBody(req) } catch { return json(res, { error: 'Invalid request' }, 400, corsSpinnyReq) }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : null
      if (!messages) return json(res, { error: 'messages required' }, 400, corsSpinnyReq)
      const memory = new MemoryLayer()
      const promptContext = memory.buildPromptContext({ tier: parsed.tier || 'guru', tokenBudget: 2600 })
      const managedMessages = promptContext
        ? [{ role: 'system', content: promptContext }, ...messages]
        : messages

      corsSpinnyReq(res)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
      const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {} }

      const manager = new LlmManager()
      const excluded = new Set()
      const manualProvider = parsed.provider && parsed.provider !== 'auto' ? normalizeProviderId(parsed.provider) : null
      const tier = parsed.tier || 'guru'
      const taskType = parsed.taskType || 'reasoning'
      let attempts = 0
      try {
        while (attempts < 8) {
          attempts += 1
          const selected = manager.select({ tier, taskType, provider: attempts === 1 ? manualProvider : null, exclude: [...excluded] })
          if (!selected.provider) {
            send({ error: `No cloud provider available for ${tier}; use LOCAL/Ollama or add a vault key.`, exhausted: true, done: true })
            break
          }

          const providerRecord = selected.provider
          const stored = manager.vault.get(VAULT_NS, providerRecord.provider)
          const apiKey = stored?.key
          if (!apiKey) {
            excluded.add(providerRecord.provider)
            continue
          }

          const model = parsed.model || providerRecord.models?.[0]
          send({ route: { provider: providerRecord.provider, model, tier, taskType, reason: selected.reason, health: selected.status } })
          if (selected.status?.status === 'APPROACHING') {
            manager.event('provider.approaching', { provider: providerRecord.provider, tier, taskType, reason: selected.status.reason })
            send({ notice: `${providerRecord.name} is approaching its configured limit; routing will fall back automatically if needed.` })
          }

          try {
            const result = await streamManagedProvider({ manager, providerRecord, apiKey, model, messages: managedMessages, send })
            manager.event('request.success', { provider: providerRecord.provider, model, tier, taskType })
            const lastUser = [...messages].reverse().find(m => m?.role === 'user')?.content || ''
            if (lastUser || result.outputText) {
              memory.write('conversation', `cloud:${Date.now()}`, {
                user: String(lastUser).slice(0, 8000),
                assistant: String(result.outputText || '').slice(0, 12000),
                provider: providerRecord.provider,
                model,
                tier,
                taskType,
                at: new Date().toISOString(),
              }, { syncable: false })
              memory.write('working', `cloud:${Date.now()}`, {
                summary: `${tier}/${taskType} via ${providerRecord.provider}: ${String(lastUser).slice(0, 240)}`,
                at: new Date().toISOString(),
              }, { syncable: true })
            }
            break
          } catch (err) {
            excluded.add(providerRecord.provider)
            const info = err.providerError || classifyProviderError(err.status || 0, {}, err.message)
            manager.recordError(providerRecord.provider, info)
            manager.event('routing.fallback', { provider: providerRecord.provider, tier, taskType, reason: info.code })
            send({ notice: `Switched away from ${providerRecord.name}: ${info.code}` })
          }
        }
      } finally {
        manager.close()
        memory.close()
        if (!res.writableEnded) res.end()
      }
      return
    }

    // ── Security: manual re-attest ──────────────────────────────────────────

    if (url.pathname === '/api/security/attest' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const result = await attestAndSend()
        return json(res, result, 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    // ── Agent: tool-calling loop (cloud AI drives, local executes) ─────────

    if (url.pathname === '/api/agent' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        const messages = Array.isArray(body.messages) ? body.messages : null
        if (!messages) return json(res, { error: 'messages required' }, 400, corsSpinnyReq)

        corsSpinnyReq(res)
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
        const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {} }

        try {
          const result = await runAgent({
            messages,
            provider: body.provider || 'openai',
            model: body.model || 'gpt-4o',
            onEvent: (evt) => send(evt),
          })
          send({ type: 'final', ...result })
        } catch (err) {
          send({ type: 'error', error: err.message })
        }
        if (!res.writableEnded) res.end()
        return
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    // ── SelfCoder vertical gate ──────────────────────────────────────────────

    if ((url.pathname.startsWith('/api/selfcoder') || url.pathname === '/api/tools' || url.pathname.startsWith('/api/tools/') || url.pathname.startsWith('/preview/')) && req.method !== 'OPTIONS') {
      const state = loadState()
      if (!state.verticals?.selfcoder?.enabled) {
        return json(res, { error: 'vertical_not_enabled', message: 'SelfCoder vertical is not enabled for this node.' }, 403, corsSpinnyReq)
      }
    }

    // ── SelfCoder workflow ───────────────────────────────────────────────────

    if (url.pathname === '/api/selfcoder/status' && req.method === 'GET') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        return json(res, await selfcoderStatus(), 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/selfcoder/plan' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        if (!body.repoRoot || !body.task) return json(res, { error: 'repoRoot and task required' }, 400, corsSpinnyReq)
        const plan = await selfcoderPlan(body.repoRoot, body.task)
        return json(res, plan, 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/selfcoder/approve' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        if (!body.taskId) return json(res, { error: 'taskId required' }, 400, corsSpinnyReq)
        const result = await selfcoderApprove(body.taskId)
        return json(res, result, 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/selfcoder/start' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        if (!body.taskId) return json(res, { error: 'taskId required' }, 400, corsSpinnyReq)
        const result = await selfcoderStart(body.taskId)
        return json(res, result, 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/selfcoder/reject' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        if (!body.taskId) return json(res, { error: 'taskId required' }, 400, corsSpinnyReq)
        const result = await selfcoderReject(body.taskId)
        return json(res, result, 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    // ── Tools: filesystem ────────────────────────────────────────────────────

    if (url.pathname === '/api/tools/filesystem/read' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        return json(res, readFile(body.repoRoot, body.filePath), 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/tools/filesystem/write' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        return json(res, writeFile(body.repoRoot, body.filePath, body.content), 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/tools/filesystem/patch' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        return json(res, patchFile(body.repoRoot, body.filePath, body.oldStr, body.newStr), 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/tools/filesystem/list' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        return json(res, listDir(body.repoRoot, body.dirPath || '.'), 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    // ── Tools: git ───────────────────────────────────────────────────────────

    if (url.pathname === '/api/tools/git/status' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        return json(res, await gitStatus(body.repoRoot), 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/tools/git/branch' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        return json(res, await gitBranch(body.repoRoot, body.name, body.base || ''), 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/tools/git/commit' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        return json(res, await gitCommit(body.repoRoot, body.message), 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/tools/git/push' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        return json(res, await gitPush(body.repoRoot, body.branch), 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/tools/git/pr' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        return json(res, await gitCreatePR(body.repoRoot, body.title, body.base || 'main'), 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/tools/git/create-repo' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        return json(res, await gitCreateRepo(body.name, body.description, body.private, body.token), 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    if (url.pathname === '/api/tools/git/clone' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        return json(res, await gitClone(body.url, body.targetPath), 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    // ── Tools: generic call (for spinny.au agent loop) ───────────────────────

    if (url.pathname === '/api/tools' && req.method === 'POST') {
      if (!isTrustedOrigin(req)) return json(res, { error: 'Forbidden' }, 403, corsSpinnyReq)
      try {
        const body = await readJsonBody(req)
        const { tool, params } = body
        let result
        switch (tool) {
          case 'filesystem.read': result = readFile(params.repoRoot, params.filePath); break
          case 'filesystem.write': result = writeFile(params.repoRoot, params.filePath, params.content); break
          case 'filesystem.patch': result = patchFile(params.repoRoot, params.filePath, params.oldStr, params.newStr); break
          case 'filesystem.list': result = listDir(params.repoRoot, params.dirPath || '.'); break
          case 'git.status': result = await gitStatus(params.repoRoot); break
          case 'git.branch': result = await gitBranch(params.repoRoot, params.name, params.base || ''); break
          case 'git.commit': result = await gitCommit(params.repoRoot, params.message); break
          case 'git.push': result = await gitPush(params.repoRoot, params.branch); break
          case 'git.create_repo': result = await gitCreateRepo(params.name, params.description, params.private, params.token); break
          case 'git.clone': result = await gitClone(params.url, params.targetPath); break
          case 'git.pr': result = await gitCreatePR(params.repoRoot, params.title, params.base || 'main'); break
          case 'npm.build': result = await npmRun(params.repoRoot, 'build'); break
          case 'npm.test': result = await npmRun(params.repoRoot, 'test'); break
          case 'preview.register': {
            const previewUrl = registerPreview(params.taskId, params.distPath)
            result = { previewUrl }
            break
          }
          case 'preview.remove': removePreview(params.taskId); result = { removed: true }; break
          default: return json(res, { error: `unknown tool: ${tool}` }, 400, corsSpinnyReq)
        }
        return json(res, result, 200, corsSpinnyReq)
      } catch (err) {
        return json(res, { error: err.message }, 400, corsSpinnyReq)
      }
    }

    // ── Preview serving ──────────────────────────────────────────────────────

    if (url.pathname.startsWith('/preview/') && req.method === 'GET') {
      const distPath = resolvePreviewDist(url.pathname)
      if (!distPath) {
        return json(res, { error: 'preview not found' }, 404, corsSpinnyReq)
      }
      const subPath = url.pathname.replace(/^\/preview\/[^/]+/, '') || '/index.html'
      const full = join(distPath, subPath)
      return serveStatic(res, full)
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
      if (DASHBOARD_TOKEN && token.trim() !== DASHBOARD_TOKEN) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        return res.end(LOGIN_PAGE('Invalid token — try again'))
      }
      const maxAge = 60 * 60 * 24 * 30 // 30 days
      // Add Secure flag when accessed via HTTPS (tailscale serve sets X-Forwarded-Proto)
      const isHttps = req.headers['x-forwarded-proto'] === 'https'
      const secureFlag = isHttps ? '; Secure' : ''
      res.writeHead(302, {
        'Set-Cookie': `spinny_dash=${DASHBOARD_TOKEN || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureFlag}`,
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
