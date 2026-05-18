import { execSync, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { loadState } from './state.js'

const PORT = 47821
const __dirname = dirname(fileURLToPath(import.meta.url))

function openUrl(url) {
  try {
    if (process.platform === 'win32') execSync(`start "" "${url}"`)
    else if (process.platform === 'darwin') execSync(`open "${url}"`)
    else execSync(`xdg-open "${url}"`)
  } catch {}
}

// Spinny brand icon: 32x32 PNG with amber-cyan-purple gradient matching favicon
const ICON_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAIs0lEQVR42pVXZ1dV1xa9vyWKGqMmGo2xxF5RLLHHXhBjFOxYg/2p2BFQI00RxNhLjIAiYMUu3N7vRX2WvV/GOPfT+zLfmGuDgC8vL54x9jice8/da6655pprY7P9xZUa/RfWRxXS6t9hc/1bWZvq3yEt+h7rohqron8gJWIhJRjDUm8MK5wxpL6IYe3jGDbci2FjVQxbymOwfcq1OBLDyugf2BBVGOQIYKTTi++dLkx0OjDJ5cAEpxNjnW7EO30Y4Aiiu70eX9S9RavnGu1qNDpUaXQu1fjmokavEo1++RrbSmPYccXC7nMW/m/wznWv0dcexginVwLOcr3AfPdTLHQ/xiL3I7knup9ihqsW451ODHP40MseQce6NwbEA42OtzS6XNP49pzGdyc1Bv6iMeygxqgdGntP/w8QyaEYvqz7J/o6whjl9GCaqxYL3E+w3PMAa713keatxkZvNX723sYa710s8dQIsCkuu4DtZY8KE3FPNdrf1fiyXKPbZY2eDSwMydIYuVvj+80K+4s+ApESiOHzunfoaY8K5QzObBlom68Se303cMhfikz/dWT4y7DbdwNbvFVY5bkvICe77Bjm8OMb+0u0rlVo+1CjY2UTC30KNQYd1YjfrzFmm8LEdQoZBc1AJIdj6FL3GoMdAaH9R/cTyXqnrwLZ/usoCFzBqeBFnA5eQHHwIvICVwXQdl+lgEh0P8M4pwv9HCEpRWuycEfjqzKjhd7FGgNymsow/meFgyeaAaCSe9ijSHB6MNv1XGjf7rslwRnwSuhXlIeKUREuQlnoFC4Gz+JE4DIy/KXY5K1CiechprnqRI/d7C/x2QuNdvc1Ot3U6HrFiLF/nsbQTI2EXRrjNiocLGwAQPpZO9Z+nNMplK773sE+XzmOBy5L8NvhQjyL5KIukoMnkXxUhotwIXgWuYHfsMt3E6mee5jrfibaYRnb1L5H2xojxq9/0+jxq0a/gmY62KQwOVUhM9eCjT3cqe6NtBTpZ+03eaul3qT8ZqgYzyO5iNRn4U19BgLRw3gUycf1UAlOBi5hv79cACe5n0q7fmcPi57aPNLoUKnx9TWNHmc0+h7XGJytMWKPEaIAyGsAQPUPdARFTIs9j7DZWyX0nwmeR2X4JBzRY3hXfxD/fpWOV/WZAqg8dErKc9Bfhg3e28IcGexjD6N9I4AqI8QeZ1sCGEsAq5sB6PgRAxuFgVKUBC/gRqhY6A/XZ+N1/SH4o0fwKFKA30MlKAxcFgbWtWAggnafwsCSQAztqQF7WJSc5H4iG1IDVP/l0BlUhwvxNJKHF5Ecof9WuAjng+eQIxqokE6Y437+QQNxzTVwVaPnX2lgiS+GuFqFHvZ6JDi94nzsAvZ/lv86igKXcCl0RtRPNlh7CvB44IrQT70kex5iqnSBH13tr9CqoQu+vGnM6EMXHGrqgikrFbJyLNiWeWJiobRgev9El0PqSRPa4asQMeYHrkq9S4IXRXhUP4Nv9VVipec+5rmfCf39HGEpZ9yf+cCxlj7ww3KFrGMWbMudMbR5rNGu1jghbZXZ0PNXe+5hq7cSe3w3JCDN54C/DOm+m5I5g7P21M5Qh188oBWdsKaZE57V6HNCY9ARjfh9TU44balC9lELtpV1MXx+T6P1My3tSBXTkAiCeljqqRE2qPQ0721s8N6Rvqf5MPPJLgeGO3wCnuqPe2Kyb5wFMhHzWs4CdsD0ZIXDRyzYUp/HpF2ImrVjS7KX4x0+Gb2cerRa2jNZYXloOpwXFC0zZ/AOdW8lCdZexNc4DQvNNBzenP4VCjMXKhzNsmDj4YG1+qJayxAhCNaRoqQ3sCSc/xy9BMReH+10S9b0fg6g9o3BH5jW63y94Txwqil76f8tChPXKkxbojAnSeGXQxZs6+/HxK+/Km8AUWPKQTslG93tL9HbHhGrZkC2K0cv6y2Dp1YJ7cxcgpdqdLuk0fO06X3WfviBpuyp/pmLFObNUcg5YMGWdjsmQhEQZWYTaoJGQiCtao1AmSVnBu9ta9/js1otU4+scf6TdmbO4PR+Ck8OIhkaCemm9pPWNGWfNEMhd68F2+aKmJxa6Fb8cZffTf9SF9yYtLZ5qKVT4h6bO4Pyc4qNgCk4Kp60M3POf7Ydpx+pH7NVYcJ603qsfeIchYWTFfLTLdh4XuOs5o/44+7nDRsCpFyjU4VpKQLqUG3ufOaoJWN8j2qn4Fhz0j6wefDtylC/SmHGYoW5iQoLpiksHqdwfIcF246rlrxMumiXvYuMdRIIGel61SiagWRdMyOWIJkxAxM4WaTgePIZmtEyOG13ekoT9YsmKixNUDi51YIt/bwl/UmXGnzYnFz6FpgNmRE3Z3mok8bFZ35OhyNzPPMxAaqdghuZbgynefDZCxTmzzLUp4xRWDFUoXijBRtPqWO3KiTs1Ijfa0TDqcUN++eazUkrRcXFvwmQ2RIsM2ZgJsCsqXYKjjUn7Y3BExl8ikLyWIXlwxVW91co2dBwKtp3ypIBQdQEwo2YCankpgREdj6sbI0hmQYsD5pkkIGZyPg0o3aaDWtO2uc3Dx6vkDqgWXBeGcctoYoeTSA0jNHbDRjSSUCy9po7A7K1Ru3U8h4PGAxMk2HWbLWZPxnBJc00tH8IPlBhXa+PAGQfswTt1GVmA2ZACrkpZzcpJajGxWcCZY353qTVxmA4YGYsUpidZFqNaqfgWHPSzswZfH3PjwDw4mBgrehSrBvBkEYC4vBgEALjnWzxc34/dakZLMyYdM+ba5ROytlqVDsFx5oz8J8Gb7yOZlqCnNQRzKyFBhDZmZFsAvHOZwbk98x27jyFxNkKSdNN4EUTTNbL4hVWDVZY0/dvBG+86M/HMiwZFBQPN2ZWLdYc8/n8mSbojz8o/DTJZJwyWmHZCIWVQ0zW63qboI3rk/5Tzt1nIWe/JUPjv9Z+C/w+b4+F/N0WCnZZOPEPC4XbLBRttlCc9veC/gfD1NGQTEvTMgAAAABJRU5ErkJggg=='

function buildMenu(state, relayConnected) {
  const statusText = statusLabel(state, relayConnected)

  return [
    { title: statusText, enabled: false, name: 'status' },
    { title: '<separator>', name: 'sep1' },
    { title: 'Open Local Panel', name: 'panel', enabled: true },
    { title: 'Open spinny.au', name: 'web', enabled: true },
    { title: '<separator>', name: 'sep2' },
    { title: 'Quit', name: 'quit', enabled: true },
  ]
}

function statusLabel(state, relayConnected) {
  const healthy = state.paired && relayConnected
  return state.paired ? (healthy ? 'Healthy' : 'Relay offline') : 'Pairing needed'
}

// Convert a PNG data URL to a minimal ICO file buffer (PNG-in-ICO, supported since Vista)
function pngDataUrlToIco(dataUrl) {
  const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
  const png = Buffer.from(b64, 'base64')
  // Read actual width/height from PNG IHDR chunk (bytes 16-23)
  const w = png.readUInt32BE(16)
  const h = png.readUInt32BE(20)
  const ico = Buffer.allocUnsafe(22 + png.length)
  ico.writeUInt16LE(0, 0)                   // reserved
  ico.writeUInt16LE(1, 2)                   // type = icon
  ico.writeUInt16LE(1, 4)                   // count = 1
  ico[6] = w > 255 ? 0 : w                  // width  (0 means 256)
  ico[7] = h > 255 ? 0 : h                  // height
  ico[8] = 0                                // color count (0 = true color)
  ico[9] = 0                                // reserved
  ico.writeUInt16LE(1, 10)                  // planes
  ico.writeUInt16LE(32, 12)                 // bit depth
  ico.writeUInt32LE(png.length, 14)         // image data size
  ico.writeUInt32LE(22, 18)                 // image data offset
  png.copy(ico, 22)
  return ico
}

function trayRuntimeDir() {
  const dir = join(process.env.LOCALAPPDATA || process.cwd(), 'SpinnyLocalMinimal', 'tray')
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeWindowsTrayStatus(getStatus) {
  const state = loadState()
  const status = getStatus?.() || {}
  writeFileSync(join(trayRuntimeDir(), 'status.txt'), statusLabel(state, status.relayConnected ?? false), 'utf8')
}

function startWindowsTray({ getStatus } = {}) {
  const dir = trayRuntimeDir()
  const iconPath = join(dir, 'spinny-icon.ico')
  const statusPath = join(dir, 'status.txt')
  writeFileSync(iconPath, pngDataUrlToIco(ICON_BASE64))
  writeWindowsTrayStatus(getStatus)

  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-STA',
    '-File',
    join(__dirname, '..', 'scripts', 'tray-windows.ps1'),
    '-IconFile',
    iconPath,
    '-StatusFile',
    statusPath,
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (line === 'panel') openUrl(`http://localhost:${PORT}`)
      if (line === 'web') openUrl('https://spinny.au')
      if (line === 'quit') process.exit(0)
    }
  })
  child.stderr.on('data', (chunk) => {
    const msg = String(chunk).trim()
    if (msg) console.log(`Windows tray helper: ${msg}`)
  })

  const timer = setInterval(() => writeWindowsTrayStatus(getStatus), 3000)
  child.on('exit', () => clearInterval(timer))

  return {
    process: child,
    kill() {
      clearInterval(timer)
      child.kill()
    },
  }
}

export async function startTray({ getStatus } = {}) {
  if (process.platform === 'win32') {
    try {
      return startWindowsTray({ getStatus })
    } catch (err) {
      console.log(`Windows tray failed to start: ${err.message} - continuing without tray`)
      return null
    }
  }

  let SysTray
  try {
    // Dynamic import to avoid crashing if native module unavailable
    const mod = await import('systray2').catch(() => null)
    if (!mod) {
      console.log('System tray unavailable (native module not found) â€” continuing without tray')
      return null
    }
    // CJS→ESM interop: systray2 exports { default: Constructor }
    // so mod.default is the CJS exports object, mod.default.default is the class
    const raw = mod.default
    SysTray = typeof raw === 'function' ? raw
            : typeof raw?.default === 'function' ? raw.default
            : mod.SysTray
  } catch {
    console.log('System tray unavailable â€” continuing without tray')
    return null
  }

  const state = loadState()
  const status = getStatus?.() || {}

  let tray
  try {
    tray = new SysTray({
      menu: {
        icon: ICON_BASE64,
        title: '',
        tooltip: 'Spinny Local',
        items: buildMenu(state, status.relayConnected ?? false),
      },
      debug: false,
      copyDir: false,
    })
  } catch (err) {
    console.log(`System tray failed to start: ${err.message} â€” continuing without tray`)
    return null
  }

  tray.onClick((action) => {
    const seq = action.seq_id
    if (seq === 2) openUrl(`http://localhost:${PORT}`)  // Open Local Panel
    if (seq === 3) openUrl('https://spinny.au')          // Open spinny.au
    if (seq === 5) { tray.kill(); process.exit(0) }      // Quit
  })

  // Refresh menu every 10 seconds
  setInterval(() => {
    const s = loadState()
    const st = getStatus?.() || {}
    try {
      tray.sendAction({ type: 'update-menu', menu: { items: buildMenu(s, st.relayConnected ?? false) } })
    } catch {}
  }, 10_000)

  return tray
}
