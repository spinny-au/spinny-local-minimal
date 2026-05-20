import { Vault } from './vault.js'

const NS = 'subagents'
const CHECK_INTERVAL_MS = 60_000

let _handle = null

export function startSubagentScheduler(handlers = {}) {
  if (_handle) return
  console.log('[subagent-scheduler] starting')
  _handle = setInterval(() => _runDue(handlers).catch(err =>
    console.error('[subagent-scheduler] cycle error:', err.message)
  ), CHECK_INTERVAL_MS)
  _runDue(handlers).catch(() => {})
}

export function stopSubagentScheduler() {
  if (_handle) { clearInterval(_handle); _handle = null }
}

export function deploySubagent(params = {}) {
  const sa = params.subagent
  if (!sa?.id || !sa?.vertical) throw new Error('subagent.id and subagent.vertical are required')
  const vault = new Vault()
  try {
    const existing = vault.get(NS, sa.id) || {}
    const record = {
      ...existing, ...sa,
      status: 'active',
      deployedAt: new Date().toISOString(),
      lastRunAt: null,
      nextRunAt: new Date(Date.now() + (sa.cycle_ms || 4 * 60 * 60 * 1000)).toISOString(),
      planId: params.planId || null,
      runCount: 0,
    }
    vault.put(NS, record.id, record)
    return { ok: true, subagent: _pub(record) }
  } finally { vault.close() }
}

export function listSubagents() {
  const vault = new Vault()
  try {
    return { ok: true, subagents: vault.list(NS, 100).map(({ value }) => _pub(value)) }
  } finally { vault.close() }
}

export function pauseSubagent({ id } = {}) { return _setStatus(id, 'paused') }
export function resumeSubagent({ id } = {}) { return _setStatus(id, 'active') }

export function removeSubagent({ id } = {}) {
  if (!id) throw new Error('id required')
  const vault = new Vault()
  try {
    vault.db.prepare('DELETE FROM encrypted_items WHERE namespace = ? AND item_key = ?').run(NS, id)
    return { ok: true, removed: id }
  } finally { vault.close() }
}

async function _runDue(handlers) {
  const vault = new Vault()
  let items
  try { items = vault.list(NS, 100) } finally { vault.close() }
  const now = Date.now()
  for (const { value: sa } of items) {
    if (sa.status !== 'active') continue
    const next = sa.nextRunAt ? new Date(sa.nextRunAt).getTime() : 0
    if (now < next) continue
    console.log(`[subagent-scheduler] running ${sa.id} (${sa.vertical})`)
    try {
      await _execute(sa, handlers)
      _update(sa.id, {
        lastRunAt: new Date().toISOString(),
        nextRunAt: new Date(Date.now() + (sa.cycle_ms || 4 * 60 * 60 * 1000)).toISOString(),
        runCount: (sa.runCount || 0) + 1,
        lastError: null,
      })
    } catch (err) {
      console.error(`[subagent-scheduler] ${sa.id} failed:`, err.message)
      _update(sa.id, {
        lastRunAt: new Date().toISOString(),
        nextRunAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        lastError: err.message,
      })
    }
  }
}

async function _execute(sa, handlers) {
  const { monitorEmails, executeEmailAction, sendTelegramNotification, formatTelegramNotification } = handlers
  if (sa.vertical === 'email-automation') {
    if (!monitorEmails) return
    const result = await monitorEmails({ limit: 25, accountEmail: sa.tasks?.[0]?.params?.accountEmail })
    const rules = sa.rules || {}
    for (const email of result.emails || []) {
      const cat = email.classification?.category
      const autoDelete = cat === 'spam' && !rules.require_approval_for_delete &&
        (rules.auto_delete || []).some(kw =>
          email.subject?.toLowerCase().includes(kw.toLowerCase()) ||
          email.from?.toLowerCase().includes(kw.toLowerCase())
        )
      if (autoDelete) {
        try { await executeEmailAction({ emailId: email.id, action: 'delete' }) } catch {}
      }
    }
    if (sendTelegramNotification) {
      for (const email of (result.flagged || []).slice(0, 5)) {
        const msg = formatTelegramNotification ? formatTelegramNotification(email) : null
        if (msg) { try { await sendTelegramNotification({ email, message: msg }) } catch {} }
      }
    }
    return result
  }
}

function _setStatus(id, status) {
  if (!id) throw new Error('id required')
  return _update(id, { status })
}

function _update(id, updates) {
  const vault = new Vault()
  try {
    const existing = vault.get(NS, id)
    if (!existing) throw new Error(`subagent not found: ${id}`)
    const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() }
    vault.put(NS, id, updated)
    return { ok: true, subagent: _pub(updated) }
  } finally { vault.close() }
}

function _pub(sa) {
  if (!sa) return null
  return {
    id: sa.id, vertical: sa.vertical, status: sa.status || 'unknown',
    cycle: sa.cycle || null, cycle_ms: sa.cycle_ms || null,
    deployedAt: sa.deployedAt || null, lastRunAt: sa.lastRunAt || null,
    nextRunAt: sa.nextRunAt || null, runCount: sa.runCount || 0,
    lastError: sa.lastError || null, planId: sa.planId || null,
    taskCount: (sa.tasks || []).length,
  }
}
