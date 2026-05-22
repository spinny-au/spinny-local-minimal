import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ENV_PATH = join(import.meta.dirname, '..', '.env')

const DEFAULTS = {
  OLLAMA_KEEP_ALIVE: '-1',
}

export function ensureEnvDefaults() {
  let content = ''
  try { content = readFileSync(ENV_PATH, 'utf8') } catch {}

  const lines = content.split(/\r?\n/)
  const keys = new Set(
    lines
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.split('=')[0].trim())
  )

  const additions = []
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!keys.has(key)) additions.push(`${key}=${value}`)
  }

  if (additions.length === 0) return

  const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
  writeFileSync(ENV_PATH, content + sep + additions.join('\n') + '\n', 'utf8')
  console.log(`[env] set ${additions.join(', ')} in .env`)
}
