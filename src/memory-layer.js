import { randomUUID, createHash } from 'node:crypto'
import { Vault } from './vault.js'
import { loadState } from './state.js'

const META_NS = 'memory:meta'
const AUDIT_NS = 'memory:audit'
const CATEGORY_PREFIX = 'memory:'

const DEFAULT_IDENTITY = {
  name: 'Spinny',
  personality: {
    tone: 'friendly',
    style: 'personal, concise, technically capable',
    verbosity: 'balanced',
  },
  introduction: "Hi, I'm Spinny. I remember your local context and keep your data on your node.",
  lockedName: true,
}

const DEFAULT_CATEGORIES = [
  'identity',
  'user_profile',
  'conversation',
  'working',
  'verticals',
  'nodes',
  'preferences',
  'pinned',
]

export class MemoryLayer {
  constructor(vault = new Vault()) {
    this.vault = vault
    this.ensureInitialized()
  }

  close() {
    this.vault?.close?.()
  }

  ensureInitialized() {
    const meta = this.vault.get(META_NS, 'schema')
    if (!meta) {
      this.vault.put(META_NS, 'schema', {
        version: 1,
        categories: DEFAULT_CATEGORIES,
        createdAt: now(),
        updatedAt: now(),
      })
    }
    if (!this.read('identity', 'spinny')) {
      this.write('identity', 'spinny', DEFAULT_IDENTITY, { syncable: true, audit: false })
    }
    return this.vault.get(META_NS, 'schema')
  }

  registerVertical({ name, categories = [], summariseForPrompt = true, syncable = true, retentionDays = null } = {}) {
    assertName(name, 'vertical name')
    const existing = this.read('verticals', `registry:${name}`) || {}
    const record = {
      ...existing,
      name,
      categories,
      summariseForPrompt,
      syncable,
      retentionDays,
      updatedAt: now(),
      createdAt: existing.createdAt || now(),
    }
    this.write('verticals', `registry:${name}`, record, { syncable })
    return record
  }

  read(category, key) {
    assertName(category, 'category')
    assertKey(key)
    const row = this.vault.get(ns(category), key)
    return row?.value ?? null
  }

  entry(category, key) {
    assertName(category, 'category')
    assertKey(key)
    return this.vault.get(ns(category), key)
  }

  write(category, key, value, options = {}) {
    assertName(category, 'category')
    assertKey(key)
    const existing = this.vault.get(ns(category), key)
    const entry = {
      key,
      category,
      value,
      pinned: options.pinned === true || existing?.pinned === true,
      syncable: options.syncable !== false,
      ttl: options.ttl ?? existing?.ttl ?? null,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
      versionHash: hashJson(value),
    }
    this.vault.put(ns(category), key, entry)
    if (options.audit !== false) this.audit('write', category, key)
    return entry
  }

  list(category, limit = 100) {
    assertName(category, 'category')
    return this.vault.list(ns(category), limit).map(({ key, value }) => ({
      key,
      category,
      pinned: value?.pinned === true,
      syncable: value?.syncable !== false,
      updatedAt: value?.updatedAt || null,
      createdAt: value?.createdAt || null,
      versionHash: value?.versionHash || null,
    }))
  }

  search(category, query, limit = 20) {
    assertName(category, 'category')
    const q = tokenize(query)
    if (!q.size) return []
    const rows = this.vault.list(ns(category), 1000)
    return rows
      .map(({ key, value }) => {
        const text = JSON.stringify(value?.value ?? '')
        const tokens = tokenize(text)
        let score = 0
        for (const token of q) if (tokens.has(token)) score += 1
        if (value?.pinned) score += 2
        return { key, value: value?.value ?? null, score, updatedAt: value?.updatedAt || null }
      })
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit)
  }

  summarise(category, limit = 12) {
    assertName(category, 'category')
    const rows = this.vault.list(ns(category), 200).map(({ key, value }) => ({ key, ...value }))
    if (!rows.length) return ''
    const pinned = rows.filter(row => row.pinned).slice(0, limit)
    const recent = rows.filter(row => !row.pinned).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, Math.max(0, limit - pinned.length))
    return [...pinned, ...recent].map(row => `- ${row.key}: ${compact(row.value)}`).join('\n')
  }

  delete(category, key) {
    assertName(category, 'category')
    assertKey(key)
    this.vault.db.prepare('DELETE FROM encrypted_items WHERE namespace = ? AND item_key = ?').run(ns(category), key)
    this.audit('delete', category, key)
    return true
  }

  clear(category) {
    assertName(category, 'category')
    this.vault.db.prepare('DELETE FROM encrypted_items WHERE namespace = ?').run(ns(category))
    this.audit('clear', category, '*')
    return true
  }

  pin(text, key = null) {
    const id = key || `pin:${randomUUID()}`
    return this.write('pinned', id, { text: String(text || '').trim() }, { pinned: true, syncable: true })
  }

  rememberFact(text, category = 'general') {
    const id = `fact:${randomUUID()}`
    return this.write('conversation', id, {
      text: String(text || '').trim(),
      category,
      source: 'user',
    }, { syncable: true })
  }

  buildPromptContext({ tier = 'guru', tokenBudget = 3000 } = {}) {
    const identity = this.read('identity', 'spinny') || DEFAULT_IDENTITY
    const state = loadState()
    const sections = []
    sections.push(`[SPINNY IDENTITY]\nName: ${identity.name || 'Spinny'}\nPersonality: ${compact(identity.personality)}\nIntroduction: ${identity.introduction || DEFAULT_IDENTITY.introduction}`)

    const profile = this.summarise('user_profile', 10)
    if (profile) sections.push(`[USER]\n${profile}`)

    const pinned = this.summarise('pinned', 20)
    if (pinned) sections.push(`[PINNED]\n${pinned}`)

    const nodes = this.summarise('nodes', 12)
    const localNode = state.nodeId ? `- local node: ${state.nodeName || state.nodeId} (${state.paired ? 'paired' : 'not paired'})` : ''
    if (nodes || localNode) sections.push(`[NODES]\n${[localNode, nodes].filter(Boolean).join('\n')}`)

    const verticals = this.summarise('verticals', 12)
    if (verticals) sections.push(`[ACTIVE VERTICALS]\n${verticals}`)

    const prefs = this.summarise('preferences', 12)
    if (prefs) sections.push(`[PREFERENCES]\n${prefs}`)

    const working = this.summarise('working', 18) || this.summarise('conversation', 18)
    if (working) sections.push(`[RECENT CONTEXT]\n${working}`)

    return fitBudget(sections.join('\n\n'), tokenBudget)
  }

  stats() {
    const categories = new Set(DEFAULT_CATEGORIES)
    const meta = this.vault.get(META_NS, 'schema')
    for (const c of meta?.categories || []) categories.add(c)
    const rows = [...categories].map(category => {
      const entries = this.list(category, 1000)
      return {
        category,
        count: entries.length,
        lastUpdated: entries.map(e => e.updatedAt).filter(Boolean).sort().pop() || null,
      }
    })
    return {
      version: 1,
      encrypted: true,
      categories: rows,
      promptPreview: this.buildPromptContext({ tokenBudget: 1200 }),
    }
  }

  audit(action, category, key) {
    const id = `${Date.now()}-${randomUUID()}`
    const prev = this.vault.list(AUDIT_NS, 1)[0]?.value?.chainHash || ''
    const record = {
      id,
      action,
      category,
      keyHash: createHash('sha256').update(String(key)).digest('hex').slice(0, 16),
      at: now(),
      previousHash: prev,
    }
    record.chainHash = hashJson(record)
    this.vault.put(AUDIT_NS, id, record)
  }
}

export function withMemory(fn) {
  const memory = new MemoryLayer()
  try {
    return fn(memory)
  } finally {
    memory.close()
  }
}

function ns(category) {
  return `${CATEGORY_PREFIX}${category}`
}

function now() {
  return new Date().toISOString()
}

function assertName(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9_:-]{1,80}$/i.test(value)) throw new Error(`invalid ${label}`)
}

function assertKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('invalid memory key')
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function tokenize(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9_:-]+/g) || [])
}

function compact(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value.length > 360 ? `${value.slice(0, 360)}...` : value
  const text = JSON.stringify(value)
  return text.length > 360 ? `${text.slice(0, 360)}...` : text
}

function fitBudget(text, budget) {
  const words = text.split(/\s+/)
  const approxTokens = Math.ceil(words.length / 0.75)
  if (approxTokens <= budget) return text
  return `${words.slice(0, Math.max(80, Math.floor(budget * 0.75))).join(' ')}\n[context compressed]`
}
