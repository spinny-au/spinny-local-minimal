import { randomUUID, createHash } from 'node:crypto'
import { Vault } from './vault.js'

export const BYOK_NS = 'byok'
const PROVIDER_NS = 'llm:providers'
const USAGE_NS = 'llm:usage'
const CONFIG_NS = 'llm:config'
const EVENTS_NS = 'llm:events'

const NOW = () => new Date().toISOString()

export const PROVIDER_PRESETS = {
  openai: {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    modelEndpoint: 'https://api.openai.com/v1/models',
    format: 'openai',
    openAICompatible: true,
    models: ['gpt-4o-mini', 'gpt-4o', 'o4-mini'],
    paid: true,
    pricing: { inputPerMTok: 2.5, outputPerMTok: 10 },
    limits: { type: 'PER_DAY', requests: null, tokens: null },
    tiers: ['guru', 'fenrir'],
  },
  xai: {
    name: 'xAI / Grok',
    endpoint: 'https://api.x.ai/v1/chat/completions',
    modelEndpoint: 'https://api.x.ai/v1/models',
    format: 'openai',
    openAICompatible: true,
    models: ['grok-4', 'grok-3-mini'],
    paid: true,
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    limits: { type: 'PER_DAY', requests: null, tokens: null },
    tiers: ['guru', 'fenrir'],
  },
  grok: {
    aliasFor: 'xai',
    name: 'Grok',
  },
  anthropic: {
    name: 'Anthropic Claude',
    endpoint: 'https://api.anthropic.com/v1/messages',
    format: 'anthropic',
    openAICompatible: false,
    models: ['claude-sonnet-4-5-20251022', 'claude-haiku-4-5-20251001'],
    paid: true,
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    limits: { type: 'PER_DAY', requests: null, tokens: null },
    tiers: ['fenrir'],
  },
  openrouter: {
    name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    modelEndpoint: 'https://openrouter.ai/api/v1/models',
    format: 'openai',
    openAICompatible: true,
    models: ['deepseek/deepseek-chat-v3-0324:free', 'meta-llama/llama-3.3-70b-instruct:free'],
    paid: false,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    limits: { type: 'PER_DAY', requests: null, tokens: null },
    tiers: ['core', 'guru'],
  },
  cerebras: {
    name: 'Cerebras',
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    format: 'openai',
    openAICompatible: true,
    models: ['llama-3.3-70b'],
    paid: false,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    limits: { type: 'PER_DAY', tokens: 1_000_000, requests: null },
    tiers: ['core', 'guru', 'fenrir'],
  },
  groq: {
    name: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    modelEndpoint: 'https://api.groq.com/openai/v1/models',
    format: 'openai',
    openAICompatible: true,
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    paid: false,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    limits: { type: 'PER_MINUTE', tokens: 6_000, requests: null },
    tiers: ['core', 'guru', 'fenrir'],
  },
  gemini: {
    name: 'Google AI Studio',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent',
    format: 'gemini',
    openAICompatible: false,
    models: ['gemini-2.5-flash', 'gemini-1.5-flash'],
    paid: false,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    limits: { type: 'PER_DAY', requests: 1_500, tokens: null },
    tiers: ['core', 'guru', 'fenrir'],
  },
  sambanova: {
    name: 'SambaNova',
    endpoint: 'https://api.sambanova.ai/v1/chat/completions',
    format: 'openai',
    openAICompatible: true,
    models: ['DeepSeek-R1', 'Meta-Llama-3.3-70B-Instruct'],
    paid: false,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    limits: { type: 'PER_DAY', requests: null, tokens: null },
    tiers: ['guru', 'fenrir'],
  },
  deepseek: {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    modelEndpoint: 'https://api.deepseek.com/models',
    format: 'openai',
    openAICompatible: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
    paid: true,
    pricing: { inputPerMTok: 0.3, outputPerMTok: 0.3 },
    limits: { type: 'PER_DAY', requests: null, tokens: null },
    tiers: ['guru', 'fenrir'],
  },
  mistral: {
    name: 'Mistral',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    modelEndpoint: 'https://api.mistral.ai/v1/models',
    format: 'openai',
    openAICompatible: true,
    models: ['mistral-small-latest', 'mistral-large-latest'],
    paid: false,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    limits: { type: 'PER_MONTH', tokens: 1_000_000_000, requests: null },
    tiers: ['core', 'guru'],
  },
  nvidia: {
    name: 'NVIDIA NIM',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    modelEndpoint: 'https://integrate.api.nvidia.com/v1/models',
    format: 'openai',
    openAICompatible: true,
    models: ['deepseek-ai/deepseek-r1', 'deepseek-ai/deepseek-v3'],
    paid: false,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    limits: { type: 'PER_DAY', requests: null, tokens: null },
    tiers: ['guru', 'fenrir'],
  },
}

export const DEFAULT_PRIORITY = {
  fenrir: {
    coding: ['cerebras', 'groq', 'deepseek', 'anthropic', 'openai'],
    reasoning: ['anthropic', 'openai', 'deepseek', 'gemini'],
    agentic: ['deepseek', 'anthropic', 'openai', 'gemini', 'mistral'],
    speed: ['cerebras', 'groq', 'sambanova'],
  },
  guru: {
    coding: ['cerebras', 'groq', 'gemini', 'deepseek'],
    reasoning: ['gemini', 'deepseek', 'groq', 'mistral'],
    agentic: ['deepseek', 'gemini', 'mistral', 'openrouter'],
    speed: ['groq', 'cerebras', 'gemini'],
  },
  core: {
    coding: ['groq', 'cerebras', 'openrouter'],
    reasoning: ['groq', 'gemini', 'openrouter', 'mistral'],
    speed: ['cerebras', 'groq', 'gemini'],
  },
}

export function normalizeProviderId(id) {
  const key = String(id || '').toLowerCase().trim()
  return PROVIDER_PRESETS[key]?.aliasFor || key
}

export function maskKey(key) {
  if (!key || key.length < 8) return '****'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

export function estimateTokens(messages) {
  const text = Array.isArray(messages)
    ? messages.map(m => `${m?.role || ''} ${m?.content || ''}`).join('\n')
    : String(messages || '')
  return Math.max(1, Math.ceil(text.length / 4))
}

export function classifyProviderError(status, headers = {}, bodyText = '') {
  const text = String(bodyText || '').toLowerCase()
  if (status === 429 || /rate limit|quota exceeded|too many requests/.test(text)) return { code: 'rate_limited', status: 'EXHAUSTED' }
  if (status === 402 || /insufficient quota|payment required|billing/.test(text)) return { code: 'spending_or_quota', status: 'EXHAUSTED' }
  if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden/.test(text)) return { code: 'invalid_key', status: 'ERROR' }
  if (status === 503 || status === 502 || /unavailable|timeout|overloaded/.test(text)) return { code: 'offline', status: 'OFFLINE' }
  if (/context length|maximum context|too many tokens/.test(text)) return { code: 'context_length', status: 'ERROR' }
  const retryAfter = getHeader(headers, 'retry-after')
  if (retryAfter) return { code: 'cooling', status: 'COOLING', retryAfter }
  return { code: 'provider_error', status: 'ERROR' }
}

export function getHeader(headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  const found = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase())
  return found ? headers[found] : null
}

export class LlmManager {
  constructor(vault = new Vault()) {
    this.vault = vault
  }

  close() {
    this.vault?.close?.()
  }

  registry() {
    const saved = this.vault.get(CONFIG_NS, 'registry') || {}
    const byok = this.vault.list(BYOK_NS, 100)
    const out = new Map()
    for (const item of byok) {
      const provider = normalizeProviderId(item.key)
      const preset = PROVIDER_PRESETS[provider] || {}
      out.set(provider, normalizeProviderRecord(provider, {
        ...preset,
        ...(saved.providers?.[provider] || {}),
        provider,
        keyStored: Boolean(item.value?.key),
        keyPreview: item.value?.key ? maskKey(item.value.key) : '****',
        storedAt: item.value?.storedAt || null,
      }))
    }
    for (const [provider, cfg] of Object.entries(saved.providers || {})) {
      const id = normalizeProviderId(provider)
      if (!out.has(id)) out.set(id, normalizeProviderRecord(id, { ...(PROVIDER_PRESETS[id] || {}), ...cfg, provider: id }))
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  config() {
    const saved = this.vault.get(CONFIG_NS, 'routing') || {}
    return {
      rotationEnabled: saved.rotationEnabled !== false,
      forcedProvider: saved.forcedProvider || null,
      priority: mergePriority(DEFAULT_PRIORITY, saved.priority || {}),
      updatedAt: saved.updatedAt || null,
    }
  }

  saveConfig(patch) {
    const current = this.config()
    const next = {
      ...current,
      ...patch,
      priority: mergePriority(current.priority, patch.priority || {}),
      updatedAt: NOW(),
    }
    this.vault.put(CONFIG_NS, 'routing', next)
    return next
  }

  upsertProvider(provider, patch) {
    const id = normalizeProviderId(provider)
    const saved = this.vault.get(CONFIG_NS, 'registry') || { providers: {} }
    const current = saved.providers?.[id] || {}
    const next = {
      ...saved,
      providers: {
        ...(saved.providers || {}),
        [id]: normalizeProviderRecord(id, { ...(PROVIDER_PRESETS[id] || {}), ...current, ...patch, provider: id }),
      },
      updatedAt: NOW(),
    }
    this.vault.put(CONFIG_NS, 'registry', next)
    return next.providers[id]
  }

  pauseProvider(provider, paused = true) {
    return this.upsertProvider(provider, { paused, pausedAt: paused ? NOW() : null })
  }

  select({ tier = 'guru', taskType = 'reasoning', provider = null, exclude = [] } = {}) {
    const normalizedTier = ['core', 'guru', 'fenrir'].includes(String(tier).toLowerCase()) ? String(tier).toLowerCase() : 'guru'
    const normalizedTask = normalizeTaskType(taskType)
    const cfg = this.config()
    const forced = normalizeProviderId(provider || cfg.forcedProvider)
    const registry = this.registry()
    const excluded = new Set(exclude.map(normalizeProviderId))
    const candidates = registry.filter(p => {
      if (excluded.has(p.provider)) return false
      if (p.paused) return false
      if (!p.keyStored) return false
      if (!p.tiers?.includes(normalizedTier)) return false
      const usage = this.usage(p.provider)
      const status = providerStatus(p, usage)
      return !['EXHAUSTED', 'ERROR', 'OFFLINE'].includes(status.status)
    })
    if (forced) {
      const match = candidates.find(p => p.provider === forced)
      if (match) return { provider: match, status: providerStatus(match, this.usage(match.provider)), reason: 'manual' }
    }
    const order = cfg.priority?.[normalizedTier]?.[normalizedTask] || cfg.priority?.[normalizedTier]?.reasoning || []
    const sorted = candidates.sort((a, b) => {
      const ai = order.indexOf(a.provider)
      const bi = order.indexOf(b.provider)
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    })
    const providerRecord = sorted[0] || null
    return providerRecord
      ? { provider: providerRecord, status: providerStatus(providerRecord, this.usage(providerRecord.provider)), reason: 'priority' }
      : { provider: null, status: { status: 'UNAVAILABLE' }, reason: 'none_available' }
  }

  usage(provider) {
    const id = normalizeProviderId(provider)
    const today = dayKey()
    const month = monthKey()
    const saved = this.vault.get(USAGE_NS, id) || {}
    return {
      provider: id,
      day: saved.day?.key === today ? saved.day : { key: today, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      month: saved.month?.key === month ? saved.month : { key: month, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      minute: saved.minute?.key === minuteKey() ? saved.minute : { key: minuteKey(), requests: 0, inputTokens: 0, outputTokens: 0 },
      hour: saved.hour?.key === hourKey() ? saved.hour : { key: hourKey(), requests: 0, inputTokens: 0, outputTokens: 0 },
      latencyMs: Array.isArray(saved.latencyMs) ? saved.latencyMs.slice(-10) : [],
      consecutiveFailures: saved.consecutiveFailures || 0,
      errors: Array.isArray(saved.errors) ? saved.errors.slice(-10) : [],
      lastSuccessAt: saved.lastSuccessAt || null,
      providerHeaders: saved.providerHeaders || {},
      updatedAt: saved.updatedAt || null,
    }
  }

  saveUsage(provider, usage) {
    this.vault.put(USAGE_NS, normalizeProviderId(provider), { ...usage, updatedAt: NOW() })
  }

  recordSuccess(provider, { inputTokens = 0, outputTokens = 0, latencyMs = null, headers = {}, costUsd = 0 } = {}) {
    const id = normalizeProviderId(provider)
    const usage = this.usage(id)
    for (const bucket of ['minute', 'hour', 'day', 'month']) {
      usage[bucket].requests += 1
      usage[bucket].inputTokens += inputTokens
      usage[bucket].outputTokens += outputTokens
      if (bucket === 'day' || bucket === 'month') usage[bucket].costUsd = Number((usage[bucket].costUsd + costUsd).toFixed(6))
    }
    usage.consecutiveFailures = 0
    usage.lastSuccessAt = NOW()
    if (Number.isFinite(latencyMs)) usage.latencyMs = [...usage.latencyMs, latencyMs].slice(-10)
    usage.providerHeaders = extractRateLimitHeaders(headers)
    this.saveUsage(id, usage)
    return usage
  }

  recordError(provider, errorInfo) {
    const id = normalizeProviderId(provider)
    const usage = this.usage(id)
    usage.consecutiveFailures = (usage.consecutiveFailures || 0) + 1
    usage.errors = [...usage.errors, { at: NOW(), ...errorInfo }].slice(-10)
    this.saveUsage(id, usage)
    this.event('provider.error', { provider: id, ...redact(errorInfo) })
    return usage
  }

  status() {
    const registry = this.registry()
    return {
      updatedAt: NOW(),
      providers: registry.map(provider => {
        const usage = this.usage(provider.provider)
        return {
          ...publicProvider(provider),
          usage,
          health: providerStatus(provider, usage),
        }
      }),
      routing: this.config(),
      events: this.events(20),
    }
  }

  event(type, payload = {}) {
    const id = `${Date.now()}-${randomUUID()}`
    this.vault.put(EVENTS_NS, id, {
      id,
      type,
      payload: redact(payload),
      at: NOW(),
      hash: createHash('sha256').update(JSON.stringify({ type, payload, at: NOW() })).digest('hex'),
    })
  }

  events(limit = 20) {
    return this.vault.list(EVENTS_NS, limit).map(({ value }) => value)
  }
}

export function publicProvider(provider) {
  const { key, ...rest } = provider
  return rest
}

function normalizeProviderRecord(provider, cfg) {
  const id = normalizeProviderId(provider)
  const preset = PROVIDER_PRESETS[id] || {}
  return {
    provider: id,
    name: cfg.name || preset.name || id,
    endpoint: cfg.endpoint || preset.endpoint || '',
    modelEndpoint: cfg.modelEndpoint || preset.modelEndpoint || '',
    format: cfg.format || preset.format || 'openai',
    openAICompatible: cfg.openAICompatible ?? preset.openAICompatible ?? true,
    models: Array.isArray(cfg.models) && cfg.models.length ? cfg.models : preset.models || [],
    paid: cfg.paid ?? preset.paid ?? false,
    pricing: cfg.pricing || preset.pricing || { inputPerMTok: 0, outputPerMTok: 0 },
    limits: cfg.limits || preset.limits || { type: 'PER_DAY', requests: null, tokens: null },
    dailyCapUsd: Number.isFinite(Number(cfg.dailyCapUsd)) ? Number(cfg.dailyCapUsd) : null,
    tiers: Array.isArray(cfg.tiers) && cfg.tiers.length ? cfg.tiers.map(t => String(t).toLowerCase()) : preset.tiers || ['core'],
    paused: cfg.paused === true,
    keyStored: cfg.keyStored === true,
    keyPreview: cfg.keyPreview || null,
    storedAt: cfg.storedAt || null,
    updatedAt: cfg.updatedAt || null,
  }
}

function normalizeTaskType(taskType) {
  const t = String(taskType || '').toLowerCase()
  if (['coding', 'reasoning', 'agentic', 'speed'].includes(t)) return t
  if (['media', 'chat'].includes(t)) return t === 'media' ? 'speed' : 'reasoning'
  return 'reasoning'
}

function mergePriority(base, patch) {
  const out = JSON.parse(JSON.stringify(base || {}))
  for (const [tier, groups] of Object.entries(patch || {})) {
    out[tier] = { ...(out[tier] || {}), ...(groups || {}) }
  }
  return out
}

function providerStatus(provider, usage) {
  if (provider.paused) return { status: 'PAUSED', reason: 'paused' }
  if ((usage.consecutiveFailures || 0) >= 3) return { status: 'ERROR', reason: 'consecutive_failures' }
  if (provider.dailyCapUsd && usage.day.costUsd >= provider.dailyCapUsd) return { status: 'EXHAUSTED', reason: 'daily_cap' }
  const limit = provider.limits || {}
  const bucket = limit.type === 'PER_MINUTE' ? usage.minute : limit.type === 'PER_HOUR' ? usage.hour : limit.type === 'PER_MONTH' ? usage.month : usage.day
  const usedTokens = (bucket.inputTokens || 0) + (bucket.outputTokens || 0)
  if (limit.tokens && usedTokens >= limit.tokens) return { status: 'EXHAUSTED', reason: 'token_limit', resetsAt: resetAt(limit.type) }
  if (limit.requests && bucket.requests >= limit.requests) return { status: 'EXHAUSTED', reason: 'request_limit', resetsAt: resetAt(limit.type) }
  if (limit.tokens && usedTokens >= limit.tokens * 0.85) return { status: 'APPROACHING', reason: 'token_limit', resetsAt: resetAt(limit.type) }
  if (limit.requests && bucket.requests >= limit.requests * 0.9) return { status: 'APPROACHING', reason: 'request_limit', resetsAt: resetAt(limit.type) }
  return { status: 'AVAILABLE', reason: 'ok', resetsAt: resetAt(limit.type) }
}

function extractRateLimitHeaders(headers) {
  const names = [
    'x-ratelimit-remaining-tokens',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-reset-tokens',
    'x-ratelimit-reset-requests',
    'retry-after',
  ]
  return Object.fromEntries(names.map(name => [name, getHeader(headers, name)]).filter(([, value]) => value != null))
}

function dayKey(date = new Date()) { return date.toISOString().slice(0, 10) }
function monthKey(date = new Date()) { return date.toISOString().slice(0, 7) }
function hourKey(date = new Date()) { return date.toISOString().slice(0, 13) }
function minuteKey(date = new Date()) { return date.toISOString().slice(0, 16) }

function resetAt(type = 'PER_DAY') {
  const now = new Date()
  const next = new Date(now)
  if (type === 'PER_MINUTE') next.setUTCSeconds(60, 0)
  else if (type === 'PER_HOUR') next.setUTCHours(now.getUTCHours() + 1, 0, 0, 0)
  else if (type === 'PER_MONTH') next.setUTCMonth(now.getUTCMonth() + 1, 1), next.setUTCHours(0, 0, 0, 0)
  else next.setUTCDate(now.getUTCDate() + 1), next.setUTCHours(0, 0, 0, 0)
  return next.toISOString()
}

function redact(value) {
  if (!value || typeof value !== 'object') return value
  const out = Array.isArray(value) ? [] : {}
  for (const [key, child] of Object.entries(value)) {
    if (/key|token|secret|password|authorization/i.test(key)) out[key] = '[redacted]'
    else out[key] = child && typeof child === 'object' ? redact(child) : child
  }
  return out
}
