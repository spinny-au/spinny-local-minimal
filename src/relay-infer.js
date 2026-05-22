import { spawn } from 'node:child_process'
import { loadState } from './state.js'
import { OllamaClient } from './ollama.js'
import { attemptReconnect } from './relay.js'

const POLL_INTERVAL = 1000
const TOKEN_BATCH_CHARS = 120

function baseUrl() {
  // Canonicalize to www to avoid the spinny.au → www.spinny.au redirect.
  // fetch drops the Authorization header across redirects, which causes
  // 401 reason=no_token on every auth-required request.
  let url = loadState().controlUrl || process.env.SPINNY_CONTROL_URL || 'https://www.spinny.au'
  url = url.replace(/\/$/, '')
  if (url === 'https://spinny.au') url = 'https://www.spinny.au'
  if (url === 'http://spinny.au') url = 'https://www.spinny.au'
  return url
}

function nodeHeaders() {
  const { relaySessionToken, nodeId } = loadState()
  return {
    'content-type': 'application/json',
    'x-spinny-node-id': nodeId || '',
    authorization: `Bearer ${relaySessionToken || ''}`,
  }
}

let _renewInProgress = false
async function renewTokenIf401(status) {
  if (status !== 401 || _renewInProgress) return false
  _renewInProgress = true
  try {
    console.log('[relay-infer] got 401 — forcing token renewal')
    const r = await attemptReconnect({ controlUrl: loadState().controlUrl, force: true })
    if (r.reconnected) { console.log('[relay-infer] token renewed — retrying'); return true }
    console.log('[relay-infer] token renewal failed — re-pair required')
    return false
  } finally { _renewInProgress = false }
}

let _lastClaimDiag = 0
function diagLog(...args) {
  // Throttle to once per 30s for normal cases, always log errors
  const now = Date.now()
  if (now - _lastClaimDiag > 30000) {
    console.log(...args)
    _lastClaimDiag = now
  }
}

async function claimTask() {
  const { nodeId, paired, relaySessionToken } = loadState()
  if (!paired) { diagLog('[relay-infer] skip claim: not paired'); return null }
  if (!nodeId) { diagLog('[relay-infer] skip claim: no nodeId'); return null }
  if (!relaySessionToken) { diagLog('[relay-infer] skip claim: no relaySessionToken'); return null }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${baseUrl()}/api/relay/tasks/pending`, {
        headers: nodeHeaders(),
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.task) console.log(`[relay-infer] claimed task ${data.task.taskId}`)
        return data.task || null
      }
      const body = await res.json().catch(() => ({}))
      console.log(`[relay-infer] claim got HTTP ${res.status} (attempt ${attempt + 1}) reason=${body.reason || '?'} hash=${body.hashPreview || '?'}`)
      if (await renewTokenIf401(res.status)) continue
      return null
    } catch (err) {
      console.log(`[relay-infer] claim network error: ${err.message}`)
      return null
    }
  }
  return null
}

async function postChunk(taskId, chunk) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${baseUrl()}/api/relay/task/${encodeURIComponent(taskId)}/chunk`, {
        method: 'POST',
        headers: nodeHeaders(),
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) return true
      if (await renewTokenIf401(res.status)) continue
    } catch {}
    if (attempt < 2) await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

async function runChatStream(task) {
  const { model, messages, system_prompt } = task.params || {}
  if (!model) {
    await postChunk(task.taskId, { error: 'No model specified', done: true, seq: 0 })
    return
  }

  const ollamaUrl = process.env.SPINNY_OLLAMA_URL || 'http://127.0.0.1:11434'
  const chatMessages = []
  if (system_prompt) chatMessages.push({ role: 'system', content: system_prompt })
  if (Array.isArray(messages)) chatMessages.push(...messages)

  let response
  try {
    response = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: chatMessages, stream: true }),
    })
  } catch (err) {
    await postChunk(task.taskId, { error: `Ollama connection failed: ${err.message}`, done: true, seq: 0 })
    return
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    await postChunk(task.taskId, { error: `Ollama error ${response.status}: ${text.slice(0, 200)}`, done: true, seq: 0 })
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let seq = 0
  let batch = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) {
          try {
            const evt = JSON.parse(line)
            const token = evt.message?.content || ''
            if (token) batch += token
            if (evt.done) {
              await postChunk(task.taskId, { content: batch, done: true, seq: seq++ })
              batch = ''
              return
            }
            if (batch.length >= TOKEN_BATCH_CHARS) {
              const ok = await postChunk(task.taskId, { content: batch, done: false, seq })
              if (ok) { seq++; batch = '' }
              // On failure: keep batch content — it'll be included in the next chunk or the done chunk
            }
          } catch {}
        }
        nl = buf.indexOf('\n')
      }
    }
    if (batch) await postChunk(task.taskId, { content: batch, done: true, seq: seq++ })
    else await postChunk(task.taskId, { content: '', done: true, seq: seq++ })
  } catch (err) {
    await postChunk(task.taskId, { error: err.message, done: true, seq: seq })
  }
}

function fmtBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`
}

async function runOllamaPull(task) {
  const { model } = task.params || {}
  if (!model) { await postChunk(task.taskId, { error: 'No model specified', done: true, seq: 0 }); return }
  const client = new OllamaClient()
  let seq = 0
  try {
    for await (const evt of client.pullModelStream(model)) {
      let content
      if (evt.total && evt.completed) {
        const pct = Math.round((evt.completed / evt.total) * 100)
        content = `${evt.status} — ${pct}% (${fmtBytes(evt.completed)} / ${fmtBytes(evt.total)})`
      } else {
        content = evt.status || 'working...'
      }
      const done = evt.status === 'success'
      await postChunk(task.taskId, { content, done, seq: seq++ })
      if (done) return
    }
    await postChunk(task.taskId, { content: 'success', done: true, seq: seq++ })
  } catch (err) {
    await postChunk(task.taskId, { error: err.message, done: true, seq: seq })
  }
}

async function runOllamaInstall(task) {
  let seq = 0
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let buf = ''
      const flush = (data) => {
        buf += data.toString()
        let nl = buf.indexOf('\n')
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (line) postChunk(task.taskId, { content: line, done: false, seq: seq++ }).catch(() => {})
          nl = buf.indexOf('\n')
        }
      }
      proc.stdout.on('data', flush)
      proc.stderr.on('data', flush)
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Install script exited ${code}`)))
      proc.on('error', reject)
    })
    await postChunk(task.taskId, { content: 'Ollama installed successfully', done: true, seq: seq++ })
  } catch (err) {
    await postChunk(task.taskId, { error: err.message, done: true, seq: seq })
  }
}

let polling = false

async function poll() {
  if (polling) return
  const task = await claimTask()
  if (!task) return
  polling = true
  try {
    console.log(`[relay-infer] task ${task.taskId} type=${task.type}`)
    if (task.type === 'infer.stream') {
      await runChatStream(task)
    } else if (task.type === 'ollama.pull') {
      await runOllamaPull(task)
    } else if (task.type === 'ollama.install') {
      await runOllamaInstall(task)
    } else {
      await postChunk(task.taskId, { error: `Unknown task type: ${task.type}`, done: true, seq: 0 })
    }
  } catch (err) {
    console.error('[relay-infer] unhandled error:', err.message)
    await postChunk(task.taskId, { error: err.message, done: true, seq: 0 })
  } finally {
    polling = false
  }
}

export function startRelayInfer() {
  setInterval(poll, POLL_INTERVAL).unref()
  console.log('[relay-infer] polling started')
}
