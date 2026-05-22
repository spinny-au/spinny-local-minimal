import { loadState } from './state.js'

const MAX_RING = 500
const FLUSH_TRIGGER = 50
const MAX_BATCH = 200
const FLUSH_INTERVAL_MS = 1000

const LEVELS = new Set(['info', 'warn', 'error'])
const SOURCES = new Set(['console', 'stderr', 'http', 'relay', 'task', 'vertical'])

let ring = []
let seq = 0
let lastAckSeq = 0
let timer = null
let flushing = false

function enabled() {
  return String(process.env.SPINNY_LOG_STREAM || '').toLowerCase() !== 'off'
}

function baseUrl() {
  return (loadState().controlUrl || process.env.SPINNY_CONTROL_URL || 'https://spinny.au').replace(/\/$/, '')
}

function publicEntry(entry) {
  return {
    ts: entry.ts,
    level: entry.level,
    source: entry.source,
    ...(entry.tag ? { tag: entry.tag } : {}),
    message: entry.message,
  }
}

function normalizeLevel(level) {
  const value = String(level || 'info').toLowerCase()
  if (value === 'log') return 'info'
  return LEVELS.has(value) ? value : 'info'
}

function normalizeSource(source) {
  const value = String(source || 'console').toLowerCase()
  return SOURCES.has(value) ? value : 'console'
}

function normalizeTag(tag) {
  if (tag == null) return undefined
  const value = String(tag).trim()
  return value ? value.slice(0, 120) : undefined
}

function stringify(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || value.message
  try { return JSON.stringify(value) } catch { return String(value) }
}

export function scrubSecrets(input) {
  return String(input ?? '')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt:redacted]')
    .replace(/\b(Bearer)\s+([A-Za-z0-9._~+/=-]{8,})/gi, '$1 [redacted]')
    .replace(/\b(srly_|srk_)[A-Za-z0-9._~+/=-]{8,}/g, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
    .replace(/([?&]code=)[^&\s"']{12,}/gi, '$1[redacted]')
    .replace(/(["']?code["']?\s*[:=]\s*["']?)[A-Za-z0-9._~/-]{12,}/gi, '$1[redacted]')
}

export function parseConsoleTag(message) {
  const text = String(message || '')
  const match = text.match(/^\[([A-Za-z0-9_:/.-]{1,120})\]\s*(.*)$/)
  if (!match) return { tag: undefined, message: text }
  return { tag: match[1], message: match[2] || text }
}

function pendingCount() {
  if (ring.length && lastAckSeq < ring[0]._seq - 1) lastAckSeq = ring[0]._seq - 1
  return ring.filter(entry => entry._seq > lastAckSeq).length
}

function pushEntry(entry) {
  ring.push(entry)
  if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING)
}

function scheduleSoon() {
  if (!enabled()) return
  if (pendingCount() < FLUSH_TRIGGER) return
  queueMicrotask(() => { flushLogs().catch(() => {}) })
}

export function logEvent(level, source, tag, message, extra) {
  const parts = [stringify(message)]
  if (extra !== undefined) parts.push(stringify(extra))
  const entry = {
    _seq: ++seq,
    ts: new Date().toISOString(),
    level: normalizeLevel(level),
    source: normalizeSource(source),
    tag: normalizeTag(tag),
    message: scrubSecrets(parts.filter(Boolean).join(' ')).slice(0, 8192),
  }
  pushEntry(entry)
  scheduleSoon()
  return publicEntry(entry)
}

export function logConsoleEvent(level, args) {
  const raw = args.map(stringify).join(' ')
  const parsed = parseConsoleTag(raw)
  return logEvent(level, 'console', parsed.tag, parsed.message)
}

export function captureChildStderr(child, tag = 'child-process') {
  if (!child?.stderr?.on) return child
  let buffer = ''
  child.stderr.on('data', (chunk) => {
    buffer += chunk.toString()
    let nl = buffer.search(/\r?\n/)
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? nl + 2 : nl + 1)
      if (line) logEvent('error', 'stderr', tag, line)
      nl = buffer.search(/\r?\n/)
    }
    if (buffer.length > 8192) {
      logEvent('error', 'stderr', tag, buffer)
      buffer = ''
    }
  })
  child.stderr.on('end', () => {
    const line = buffer.trim()
    if (line) logEvent('error', 'stderr', tag, line)
    buffer = ''
  })
  return child
}

export async function flushLogs() {
  if (!enabled() || flushing) return { ok: false, skipped: true }
  const state = loadState()
  if (!state.paired || !state.nodeId || !state.relaySessionToken) return { ok: false, skipped: true }
  if (ring.length && lastAckSeq < ring[0]._seq - 1) lastAckSeq = ring[0]._seq - 1
  const batch = ring.filter(entry => entry._seq > lastAckSeq).slice(0, MAX_BATCH)
  if (batch.length === 0) return { ok: true, accepted: 0 }

  flushing = true
  try {
    const res = await fetch(`${baseUrl()}/api/relay/logs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-spinny-node-id': state.nodeId,
        authorization: `Bearer ${state.relaySessionToken}`,
      },
      body: JSON.stringify({ entries: batch.map(publicEntry) }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { ok: false, status: res.status }
    const body = await res.json().catch(() => ({}))
    const accepted = Math.max(0, Math.min(batch.length, Number(body.accepted) || batch.length))
    if (accepted > 0) lastAckSeq = Math.max(lastAckSeq, batch[accepted - 1]._seq)
    return { ok: true, accepted }
  } catch {
    return { ok: false }
  } finally {
    flushing = false
  }
}

export function startLogStreamer() {
  if (timer || !enabled()) return
  timer = setInterval(() => { flushLogs().catch(() => {}) }, FLUSH_INTERVAL_MS)
  timer.unref?.()
}

export function stopLogStreamer() {
  if (timer) clearInterval(timer)
  timer = null
}

export function getLogStreamerState() {
  return {
    enabled: enabled(),
    size: ring.length,
    pending: pendingCount(),
    entries: ring.map(publicEntry),
  }
}
