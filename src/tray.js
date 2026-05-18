import { execSync } from 'node:child_process'
import { loadState } from './state.js'

const PORT = 47821

function openUrl(url) {
  try {
    if (process.platform === 'win32') execSync(`start "" "${url}"`)
    else if (process.platform === 'darwin') execSync(`open "${url}"`)
    else execSync(`xdg-open "${url}"`)
  } catch {}
}

// Base64 16x16 green dot PNG icon (simple, minimal)
const ICON_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABQSURBVDiNY2CgJvj/n4EBBxiVGhiGGhjGGhjGGhjGGhjGGhjGGhjGGhjGGhjGGhjGGhjGGhjGGhiGGhhGGhhGGhhGGhhGGhhGGhhGGpgAAMcKBhVnBrYaAAAAAElFTkSuQmCC'

function buildMenu(state, relayConnected) {
  const healthy = state.paired && relayConnected
  const statusText = state.paired ? (healthy ? '● Healthy' : '○ Relay offline') : '○ Pairing needed'

  return [
    { title: statusText, enabled: false, name: 'status' },
    { title: '<separator>', name: 'sep1' },
    { title: 'Open Local Panel', name: 'panel', enabled: true },
    { title: 'Open spinny.au', name: 'web', enabled: true },
    { title: '<separator>', name: 'sep2' },
    { title: 'Quit', name: 'quit', enabled: true },
  ]
}

export async function startTray({ getStatus } = {}) {
  let SysTray
  try {
    // Dynamic import to avoid crashing if native module unavailable
    const mod = await import('systray2').catch(() => null)
    if (!mod) {
      console.log('System tray unavailable (native module not found) — continuing without tray')
      return null
    }
    SysTray = mod.default || mod.SysTray
  } catch {
    console.log('System tray unavailable — continuing without tray')
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
      copyDir: true,
    })
  } catch (err) {
    console.log(`System tray failed to start: ${err.message} — continuing without tray`)
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
