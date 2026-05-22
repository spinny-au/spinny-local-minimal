import { execSync } from 'node:child_process'
import os from 'node:os'
import { statfsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spinnyHome } from './paths.js'

let lastCpuSample = null

// Cache ollama list + running model — refreshed every 30s so /api/system is instant
let ollamaCache = { models: [], running: false, installed: false, loadedModel: null, updatedAt: 0 }

function refreshOllamaCache() {
  let installed = false
  try { execSync('which ollama', { timeout: 2000, stdio: 'pipe' }); installed = true } catch {}

  if (!installed) {
    ollamaCache = { models: [], running: false, installed: false, loadedModel: null, updatedAt: Date.now() }
    return
  }

  try {
    const out = execSync('ollama list', { timeout: 8000, stdio: 'pipe' }).toString()
    const lines = out.split('\n').slice(1).filter(Boolean)
    const models = lines.map(l => {
      const parts = l.trim().split(/\s+/)
      const size = parts[2] ? (parts[3]?.match(/^[A-Za-z]+$/) ? `${parts[2]} ${parts[3]}` : parts[2]) : ''
      return { name: parts[0], size }
    }).filter(m => m.name && m.name !== 'NAME')

    let loadedModel = null
    try {
      const psOut = execSync('ollama ps', { timeout: 3000, stdio: 'pipe' }).toString()
      const psLines = psOut.split('\n').slice(1).filter(l => l.trim())
      if (psLines.length > 0) loadedModel = psLines[0].trim().split(/\s+/)[0] || null
    } catch {}

    ollamaCache = { models, running: true, installed: true, loadedModel, updatedAt: Date.now() }
  } catch {
    ollamaCache = { models: ollamaCache.models, running: false, installed: true, loadedModel: ollamaCache.loadedModel, updatedAt: Date.now() }
  }
}

// Cache GPU name — expensive to detect, changes never
let gpuCache = 'Not detected'
function detectGpu() {
  try {
    const out = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', { timeout: 3000, stdio: 'pipe' }).toString().trim()
    if (out) { gpuCache = out.split('\n')[0].trim(); return }
  } catch {}
  try {
    const out = execSync('wmic path win32_VideoController get name /value', { timeout: 3000, stdio: 'pipe' }).toString()
    const match = out.match(/Name=(.+)/)
    if (match) gpuCache = match[1].trim()
  } catch {}
}

// Warm the cache immediately on import, then refresh every 30s
refreshOllamaCache()
setInterval(refreshOllamaCache, 30_000).unref()
// GPU detection runs once in background — don't block startup
setImmediate(detectGpu)

function readCpuSample() {
  const cpus = os.cpus()
  const totals = cpus.reduce((acc, cpu) => {
    const times = cpu.times
    acc.idle += times.idle
    acc.total += times.user + times.nice + times.sys + times.idle + times.irq
    return acc
  }, { idle: 0, total: 0 })
  return { cpus, ...totals }
}

function getCpuInfo() {
  const sample = readCpuSample()
  let usagePercent = null
  if (lastCpuSample) {
    const idleDelta = sample.idle - lastCpuSample.idle
    const totalDelta = sample.total - lastCpuSample.total
    if (totalDelta > 0) {
      usagePercent = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10))
    }
  }
  lastCpuSample = sample
  return {
    model: sample.cpus[0]?.model || 'Unknown CPU',
    cores: sample.cpus.length,
    usagePercent,
    loadavg: os.loadavg(),
  }
}

export function getSystemInfo() {
  const totalMem = os.totalmem()
  const freeMem = os.freemem()

  const gpu = gpuCache

  let disk = { free: 0, total: 0 }
  try {
    const stat = statfsSync(spinnyHome())
    disk = { free: stat.bfree * stat.bsize, total: stat.blocks * stat.bsize }
  } catch {}

  const ollamaModels = ollamaCache.models
  const ollamaRunning = ollamaCache.running
  const ollamaInstalled = ollamaCache.installed
  const loadedModel = ollamaCache.loadedModel

  // Read package.json for version
  let version = '0.1.0'
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    version = pkg.version
  } catch {}

  let tailscaleIp = null
  try {
    const tsOut = execSync('tailscale ip --4', { timeout: 3000, stdio: 'pipe' }).toString().trim()
    if (tsOut && /^\d+\.\d+\.\d+\.\d+$/.test(tsOut)) tailscaleIp = tsOut
  } catch {}

  const serveUrl = process.env.SPINNY_SERVE_URL || null
  const nodeName = (process.env.SPINNY_NODE_NAME || '').trim() || null

  return {
    nodeName,
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: getCpuInfo(),
    ram: { total: totalMem, free: freeMem, used: totalMem - freeMem },
    disk,
    gpu,
    ollamaInstalled,
    ollamaRunning,
    models: ollamaModels,
    loadedModel,
    tailscaleIp,
    serveUrl,
    capabilities: {
      modelInstall: true,
      modelBundleExport: true,
      modelBundleImport: true,
      modelTransferFromUrl: true,
    },
    version,
  }
}
