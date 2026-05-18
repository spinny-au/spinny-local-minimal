import { execSync } from 'node:child_process'
import os from 'node:os'
import { statfsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spinnyHome } from './paths.js'

export function getSystemInfo() {
  const totalMem = os.totalmem()
  const freeMem = os.freemem()

  let gpu = 'Not detected'
  try {
    const out = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', { timeout: 3000, stdio: 'pipe' }).toString().trim()
    if (out) gpu = out.split('\n')[0].trim()
  } catch {
    try {
      const out = execSync('wmic path win32_VideoController get name /value', { timeout: 3000, stdio: 'pipe' }).toString()
      const match = out.match(/Name=(.+)/)
      if (match) gpu = match[1].trim()
    } catch {}
  }

  let disk = { free: 0, total: 0 }
  try {
    const stat = statfsSync(spinnyHome())
    disk = { free: stat.bfree * stat.bsize, total: stat.blocks * stat.bsize }
  } catch {}

  let ollamaModels = []
  let ollamaRunning = false
  try {
    const out = execSync('ollama list', { timeout: 5000 }).toString()
    ollamaRunning = true
    const lines = out.split('\n').slice(1).filter(Boolean)
    ollamaModels = lines.map(l => {
      const parts = l.trim().split(/\s+/)
      return { name: parts[0], size: parts[2] || '' }
    }).filter(m => m.name && m.name !== 'NAME')
  } catch {}

  // Read package.json for version
  let version = '0.1.0'
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    version = pkg.version
  } catch {}

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    ram: { total: totalMem, free: freeMem, used: totalMem - freeMem },
    disk,
    gpu,
    ollamaRunning,
    models: ollamaModels,
    version,
  }
}
