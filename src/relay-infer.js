import { loadState } from './state.js'

const POLL_INTERVAL = 2500
const TOKEN_BATCH_CHARS = 20

function baseUrl() {
  return (loadState().controlUrl || process.env.SPINNY_CONTROL_URL || 'https://spinny.au').replace(/\/$/, '')
}

function nodeHeaders() {
  const { relaySessionToken, nodeId } = loadState()
  return {
    'content-type': 'application/json',
    'x-spinny-node-id': nodeId || '',
    authorization: `Bearer ${relaySessionToken || ''}`,
  }
}

async function claimTask() {
  const { nodeId, paired, relaySessionToken } = loadState()
  if (!paired || !nodeId || !relaySessionToken) return null
  try {
    const res = await fetch(`${baseUrl()}/api/relay/tasks/pending`, {
      headers: nodeHeaders(),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.task || null
  } catch {
    return null
  }
}

async function postChunk(taskId, chunk) {
  try {
    await fetch(`${baseUrl()}/api/relay/task/${encodeURIComponent(taskId)}/chunk`, {
      method: 'POST',
      headers: nodeHeaders(),
      body: JSON.stringify(chunk),
      signal: AbortSignal.timeout(5000),
    })
  } catch {}
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
              await postChunk(task.taskId, { content: batch, done: false, seq: seq++ })
              batch = ''
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
