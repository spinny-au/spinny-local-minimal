import { execSync } from 'node:child_process'
import os from 'node:os'
import { statfsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spinnyHome } from './paths.js'

let lastCpuSample = null

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
      const size = parts[2] ? (parts[3]?.match(/^[A-Za-z]+$/) ? `${parts[2]} ${parts[3]}` : parts[2]) : ''
      return { name: parts[0], size }
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
    cpu: getCpuInfo(),
    ram: { total: totalMem, free: freeMem, used: totalMem - freeMem },
    disk,
    gpu,
    ollamaRunning,
    models: ollamaModels,
    capabilities: {
      modelInstall: true,
      modelBundleExport: true,
      modelBundleImport: true,
      modelTransferFromUrl: true,
    },
    version,
  }
}
