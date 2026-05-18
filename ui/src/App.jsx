import React, { useState, useEffect, useCallback } from 'react'

const css = `
.app { min-height: 100vh; display: flex; flex-direction: column; }

.header {
  background: var(--bg-card);
  border-bottom: 1px solid var(--bg-border);
  padding: 0 24px;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 56px;
}
.header-logo {
  font-size: 18px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: -0.5px;
}
.header-sub { color: var(--text-muted); font-size: 12px; }

.tabs {
  display: flex;
  gap: 2px;
  margin-left: auto;
}
.tab-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  padding: 8px 16px;
  cursor: pointer;
  font-size: 13px;
  border-radius: var(--radius);
  transition: all 0.15s;
}
.tab-btn:hover { background: var(--accent-soft); color: var(--text); }
.tab-btn.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }

.content { flex: 1; padding: 24px; max-width: 800px; margin: 0 auto; width: 100%; }

.card {
  background: var(--bg-card);
  border: 1px solid var(--bg-border);
  border-radius: var(--radius);
  padding: 20px;
  margin-bottom: 16px;
}
.card-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  margin-bottom: 16px;
}

.status-hero {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 24px;
  margin-bottom: 16px;
}
.status-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.ok { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
.status-dot.err { background: var(--err); box-shadow: 0 0 8px var(--err); }
.status-label { font-size: 20px; font-weight: 700; }
.status-label.ok { color: var(--ok); }
.status-label.err { color: var(--err); }

.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--bg-border);
}
.row:last-child { border-bottom: none; }
.row-label { color: var(--text-muted); }
.row-value { font-family: monospace; font-size: 13px; }

.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.badge.ok { background: rgba(34,197,94,0.15); color: var(--ok); }
.badge.err { background: rgba(239,68,68,0.15); color: var(--err); }
.badge.warn { background: rgba(245,158,11,0.15); color: var(--warn); }

.bar-wrap {
  background: var(--bg-border);
  border-radius: 4px;
  height: 8px;
  flex: 1;
  margin: 0 12px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 4px;
  background: var(--accent);
  transition: width 0.3s ease;
}
.bar-fill.warn { background: var(--warn); }
.bar-fill.err { background: var(--err); }

.model-list { display: flex; flex-direction: column; gap: 10px; }
.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg);
  border: 1px solid var(--bg-border);
  border-radius: var(--radius);
}
.model-name { font-family: monospace; font-size: 13px; font-weight: 600; }
.model-size { color: var(--text-muted); font-size: 12px; margin-top: 2px; }
.btn {
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition: opacity 0.15s;
}
.btn:hover { opacity: 0.85; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.secondary {
  background: var(--bg-border);
  color: var(--text);
}

.install-row {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
.install-input {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--bg-border);
  border-radius: 6px;
  color: var(--text);
  padding: 8px 12px;
  font-size: 13px;
  font-family: monospace;
  outline: none;
}
.install-input:focus { border-color: var(--accent); }

.suggested-chips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.chip {
  background: var(--bg);
  border: 1px solid var(--bg-border);
  border-radius: 6px;
  padding: 5px 12px;
  font-size: 12px;
  font-family: monospace;
  cursor: pointer;
  color: var(--text-muted);
  transition: all 0.15s;
}
.chip:hover { border-color: var(--accent); color: var(--accent); }

.msg { font-size: 12px; margin-top: 8px; padding: 8px 12px; border-radius: 6px; }
.msg.ok { background: rgba(34,197,94,0.1); color: var(--ok); }
.msg.err { background: rgba(239,68,68,0.1); color: var(--err); }

.about-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 24px;
  text-align: center;
}
.about-logo { font-size: 48px; font-weight: 800; color: var(--accent); margin-bottom: 8px; }
.about-version { color: var(--text-muted); font-size: 13px; margin-bottom: 24px; }
.about-links { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 280px; }
.link-btn {
  display: block;
  background: var(--bg);
  border: 1px solid var(--bg-border);
  border-radius: var(--radius);
  padding: 12px 20px;
  color: var(--text);
  text-decoration: none;
  font-size: 13px;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.15s;
}
.link-btn:hover { border-color: var(--accent); color: var(--accent); }

.loading { color: var(--text-muted); font-size: 13px; padding: 40px; text-align: center; }
.error-banner {
  background: rgba(239,68,68,0.1);
  border: 1px solid rgba(239,68,68,0.3);
  border-radius: var(--radius);
  padding: 12px 16px;
  color: var(--err);
  font-size: 13px;
  margin-bottom: 16px;
}
`

const SUGGESTED = ['llama3.2:3b', 'qwen2.5:7b', 'mistral:7b', 'gemma3:4b']

function usePoll(url, interval = 5000) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const fetch_ = useCallback(async () => {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      setData(d)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [url])

  useEffect(() => {
    fetch_()
    const id = setInterval(fetch_, interval)
    return () => clearInterval(id)
  }, [fetch_, interval])

  return { data, error, loading, refresh: fetch_ }
}

function fmt(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${units[i]}`
}

function BarRow({ label, used, total }) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0
  const cls = pct > 90 ? 'err' : pct > 70 ? 'warn' : ''
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <div className="bar-wrap">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="row-value" style={{ minWidth: 160, textAlign: 'right' }}>
        {fmt(used)} / {fmt(total)} ({pct.toFixed(0)}%)
      </span>
    </div>
  )
}

function StatusTab({ status, sysInfo, error }) {
  if (error) return <div className="error-banner">Could not connect to local server: {error}</div>
  if (!status) return <div className="loading">Loading status...</div>

  const healthy = status.paired && status.relayConnected
  return (
    <>
      <div className="card status-hero">
        <div className={`status-dot ${healthy ? 'ok' : 'err'}`} />
        <span className={`status-label ${healthy ? 'ok' : 'err'}`}>
          {status.paired ? (healthy ? 'Healthy' : 'Relay offline') : 'Pairing needed'}
        </span>
      </div>
      <div className="card">
        <div className="card-title">Node Details</div>
        <div className="row">
          <span className="row-label">Node ID</span>
          <span className="row-value">{status.nodeId || '—'}</span>
        </div>
        <div className="row">
          <span className="row-label">Paired account</span>
          <span className="row-value">{status.accountId || '—'}</span>
        </div>
        <div className="row">
          <span className="row-label">Relay</span>
          <span className={`badge ${status.relayConnected ? 'ok' : 'err'}`}>
            {status.relayConnected ? '● Connected' : '○ Disconnected'}
          </span>
        </div>
        <div className="row">
          <span className="row-label">Spinny version</span>
          <span className="row-value">{sysInfo?.version || status.version || '—'}</span>
        </div>
      </div>
      {!status.paired && (
        <div className="card">
          <div className="card-title">Pairing</div>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>
            This node is not yet paired. Run <code style={{ background: 'var(--bg)', padding: '2px 6px', borderRadius: 4 }}>npm start</code> to get a pairing code, then visit{' '}
            <a href="https://spinny.au" style={{ color: 'var(--accent)' }}>spinny.au</a> to complete pairing.
          </p>
        </div>
      )}
    </>
  )
}

function ModelsTab({ sysInfo, error }) {
  const [installModel, setInstallModel] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installMsg, setInstallMsg] = useState(null)

  if (error) return <div className="error-banner">Could not connect to local server: {error}</div>
  if (!sysInfo) return <div className="loading">Loading models...</div>

  async function doInstall(model) {
    const m = model || installModel.trim()
    if (!m) return
    setInstalling(true)
    setInstallMsg(null)
    try {
      const r = await fetch('/api/models/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m }),
      })
      const d = await r.json()
      if (d.ok) {
        setInstallMsg({ type: 'ok', text: `Installing ${m}... This may take a few minutes. Ollama is downloading it in the background.` })
        setInstallModel('')
      } else {
        setInstallMsg({ type: 'err', text: d.error || 'Install failed' })
      }
    } catch (e) {
      setInstallMsg({ type: 'err', text: e.message })
    } finally {
      setInstalling(false)
    }
  }

  return (
    <>
      <div className="card">
        <div className="card-title">Installed Models ({sysInfo.models?.length || 0})</div>
        {sysInfo.ollamaRunning ? null : (
          <div className="msg err" style={{ marginBottom: 12 }}>Ollama is not running. Start Ollama to manage models.</div>
        )}
        {sysInfo.models?.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No models installed yet.</div>
        ) : (
          <div className="model-list">
            {sysInfo.models.map(m => (
              <div className="model-item" key={m.name}>
                <div>
                  <div className="model-name">{m.name}</div>
                  {m.size && <div className="model-size">{m.size}</div>}
                </div>
                <button className="btn secondary" onClick={() => doInstall(m.name)} disabled={installing}>
                  Re-pull
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Install Model</div>
        <div className="install-row">
          <input
            className="install-input"
            placeholder="e.g. llama3.2:3b"
            value={installModel}
            onChange={e => setInstallModel(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && doInstall()}
          />
          <button className="btn" onClick={() => doInstall()} disabled={installing || !installModel.trim()}>
            {installing ? 'Installing...' : 'Install'}
          </button>
        </div>
        {installMsg && <div className={`msg ${installMsg.type}`}>{installMsg.text}</div>}
        <div style={{ marginTop: 16 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>Suggested models:</div>
          <div className="suggested-chips">
            {SUGGESTED.map(s => (
              <span key={s} className="chip" onClick={() => { setInstallModel(s); setInstallMsg(null) }}>{s}</span>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

function SystemTab({ sysInfo, error }) {
  if (error) return <div className="error-banner">Could not connect to local server: {error}</div>
  if (!sysInfo) return <div className="loading">Loading system info...</div>

  const ram = sysInfo.ram || {}
  const disk = sysInfo.disk || {}

  return (
    <>
      <div className="card">
        <div className="card-title">Machine</div>
        <div className="row">
          <span className="row-label">Hostname</span>
          <span className="row-value">{sysInfo.hostname || '—'}</span>
        </div>
        <div className="row">
          <span className="row-label">OS</span>
          <span className="row-value">{sysInfo.platform} {sysInfo.release}</span>
        </div>
        <div className="row">
          <span className="row-label">Architecture</span>
          <span className="row-value">{sysInfo.arch}</span>
        </div>
        <div className="row">
          <span className="row-label">GPU</span>
          <span className="row-value">{sysInfo.gpu || 'Not detected'}</span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Resources</div>
        {ram.total ? <BarRow label="RAM" used={ram.used} total={ram.total} /> : null}
        {disk.total ? <BarRow label="Disk" used={disk.total - disk.free} total={disk.total} /> : null}
      </div>

      <div className="card">
        <div className="card-title">Ollama</div>
        <div className="row">
          <span className="row-label">Status</span>
          <span className={`badge ${sysInfo.ollamaRunning ? 'ok' : 'err'}`}>
            {sysInfo.ollamaRunning ? '● Running' : '○ Not running'}
          </span>
        </div>
        <div className="row">
          <span className="row-label">Models installed</span>
          <span className="row-value">{sysInfo.models?.length ?? 0}</span>
        </div>
      </div>
    </>
  )
}

function AboutTab({ sysInfo }) {
  const version = sysInfo?.version || '0.1.0'
  return (
    <div className="card about-hero">
      <div className="about-logo">Spinny</div>
      <div className="about-version">Local Node v{version}</div>
      <div className="about-links">
        <a className="link-btn" href="https://spinny.au" target="_blank" rel="noreferrer">
          Open spinny.au
        </a>
        <a className="link-btn" href="https://github.com/spinny-au/spinny-local-minimal" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <button className="btn" style={{ marginTop: 8 }} onClick={() => window.open('https://spinny.au', '_blank')}>
          Open spinny.au
        </button>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 32, lineHeight: 1.6, maxWidth: 360 }}>
        Spinny Local runs on your machine and connects your AI models to the Spinny cloud platform. It manages Ollama models, relays tasks, and keeps your data local.
      </p>
    </div>
  )
}

const TABS = ['Status', 'Models', 'System', 'About']

export function App() {
  const [tab, setTab] = useState('Status')
  const { data: status, error: statusErr } = usePoll('/api/status', 5000)
  const { data: sysInfo, error: sysErr } = usePoll('/api/system', 5000)

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <div className="header">
          <div>
            <div className="header-logo">Spinny Local</div>
            <div className="header-sub">localhost:47821</div>
          </div>
          <div className="tabs">
            {TABS.map(t => (
              <button
                key={t}
                className={`tab-btn${tab === t ? ' active' : ''}`}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="content">
          {tab === 'Status' && <StatusTab status={status} sysInfo={sysInfo} error={statusErr} />}
          {tab === 'Models' && <ModelsTab sysInfo={sysInfo} error={sysErr} />}
          {tab === 'System' && <SystemTab sysInfo={sysInfo} error={sysErr} />}
          {tab === 'About' && <AboutTab sysInfo={sysInfo} />}
        </div>
      </div>
    </>
  )
}
