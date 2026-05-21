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
.tab-btn.update-tab { color: var(--ok); font-weight: 600; }
.tab-btn.update-tab:hover { background: rgba(34,197,94,0.1); color: var(--ok); }
.msg.info { background: rgba(255,255,255,0.04); color: var(--text-muted); font-family: monospace; font-size: 11px; }
.dl-progress-wrap { background: var(--bg-border); border-radius: 4px; height: 6px; margin-top: 6px; overflow: hidden; }
.dl-progress-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.4s ease; }
.chat-messages { display: flex; flex-direction: column; gap: 10px; max-height: 55vh; overflow-y: auto; padding: 12px 0; }
.chat-bubble-wrap { display: flex; }
.chat-bubble-wrap.user { justify-content: flex-end; }
.chat-bubble-wrap.assistant { justify-content: flex-start; }
.chat-bubble { padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.6; max-width: 85%; white-space: pre-wrap; word-break: break-word; }
.chat-bubble.user { background: var(--accent); color: #fff; border-radius: 12px 12px 2px 12px; }
.chat-bubble.assistant { background: var(--bg); border: 1px solid var(--bg-border); border-radius: 2px 12px 12px 12px; }
.chat-input-row { display: flex; gap: 8px; margin-top: 12px; }
.chat-textarea { flex: 1; background: var(--bg); border: 1px solid var(--bg-border); border-radius: 6px; color: var(--text); padding: 10px 12px; font-size: 13px; resize: none; outline: none; min-height: 42px; font-family: inherit; }
.chat-textarea:focus { border-color: var(--accent); }
.model-select { background: var(--bg); border: 1px solid var(--bg-border); border-radius: 6px; color: var(--text); padding: 6px 10px; font-size: 12px; outline: none; margin-bottom: 12px; }

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

.pairing-code-wrap {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pairing-code {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pairing-code-value {
  font-family: monospace;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: var(--accent);
  background: var(--bg);
  border: 1px solid var(--bg-border);
  border-radius: var(--radius);
  padding: 12px 20px;
  flex: 1;
  text-align: center;
}
.pairing-hint { color: var(--text-muted); font-size: 12px; line-height: 1.6; }

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

function ReconnectButton() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg]   = useState(null)
  const go = async () => {
    setBusy(true); setMsg(null)
    try {
      await fetch('/api/relay/reconnect', { method: 'POST' })
      setMsg('Reconnecting…')
    } catch (e) {
      setMsg('Failed: ' + e.message)
    } finally {
      setBusy(false)
      setTimeout(() => setMsg(null), 3000)
    }
  }
  return (
    <span>
      <button className="btn secondary" style={{ fontSize: 11, padding: '3px 10px' }} onClick={go} disabled={busy}>
        {busy ? '…' : 'Reconnect'}
      </button>
      {msg && <span style={{ fontSize: 11, marginLeft: 6, color: 'var(--text-muted)' }}>{msg}</span>}
    </span>
  )
}

function TotpRing({ remaining, ttl, size = 36 }) {
  const r = (size - 4) / 2
  const circ = 2 * Math.PI * r
  const progress = remaining / ttl
  const offset = circ * (1 - progress)
  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={3} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--accent)" strokeWidth={3}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`}
        style={{ transition: 'stroke-dashoffset 1s linear' }}
      />
    </svg>
  )
}

function PairingTokenCard() {
  const [token, setToken] = useState(null)
  const [visible, setVisible] = useState(false)
  const [copied, setCopied] = useState(false)

  const fetchToken = useCallback(async () => {
    try {
      const res = await fetch('/pairing/token')
      if (res.ok) setToken(await res.json())
    } catch {}
  }, [])

  useEffect(() => {
    fetchToken()
    const iv = setInterval(fetchToken, 3000)
    return () => clearInterval(iv)
  }, [fetchToken])

  const copy = () => {
    if (!token?.code) return
    navigator.clipboard.writeText(token.code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  if (!token) return null

  const remaining = token.remaining ?? token.ttl ?? 60
  const ttl = token.ttl ?? 60

  return (
    <div className="card">
      <div className="card-title">Pairing Token</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <TotpRing remaining={remaining} ttl={ttl} />
        <div style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 700, letterSpacing: '0.18em', flex: 1, color: 'var(--text)' }}>
          {visible ? (token.code || '——') : '••••••'}
        </div>
        <button className="btn" onClick={() => setVisible(v => !v)} title={visible ? 'Hide' : 'Reveal'} style={{ fontSize: 16, padding: '6px 10px' }}>
          {visible ? '🙈' : '👁'}
        </button>
        <button className="btn" onClick={copy} disabled={!visible}>
          {copied ? '✓' : 'Copy'}
        </button>
      </div>
      <div className="pairing-hint" style={{ marginTop: 8 }}>
        {token.pairedCount >= token.maxPairedAccounts
          ? `${token.pairedCount}/${token.maxPairedAccounts} accounts paired — token will stop rotating.`
          : `Rotates every ${ttl}s — enter at spinny.au to pair. ${token.pairedCount}/${token.maxPairedAccounts} account(s) paired.`}
      </div>
    </div>
  )
}

function AccessCard({ ownerEmail }) {
  const [access, setAccess] = useState(null)
  const [addEmail, setAddEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/node/access')
      if (r.ok) setAccess(await r.json())
    } catch {}
  }, [])

  useEffect(() => { load() }, [load])

  const patch = async (patch) => {
    setBusy(true)
    try {
      await fetch('/api/node/access', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      await load()
    } finally { setBusy(false) }
  }

  const addUser = async () => {
    const email = addEmail.toLowerCase().trim()
    if (!email || !email.includes('@')) return
    setBusy(true); setMsg(null)
    try {
      const r = await fetch('/api/node/access/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Failed')
      setAddEmail('')
      await load()
    } catch (e) { setMsg({ type: 'err', text: e.message }) }
    setBusy(false)
  }

  const removeUser = async (email) => {
    setBusy(true)
    try {
      await fetch(`/api/node/access/users/${encodeURIComponent(email)}`, { method: 'DELETE' })
      await load()
    } finally { setBusy(false) }
  }

  const approveRequest = async (email, action) => {
    setBusy(true)
    try {
      await fetch('/api/node/access/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, action }),
      })
      await load()
    } finally { setBusy(false) }
  }

  if (!access) return null

  const { multiAccount, locked, allowedUsers = [], pendingRequests = [] } = access
  const allAccounts = [
    { email: ownerEmail, owner: true },
    ...allowedUsers.filter(u => u.email !== ownerEmail).map(u => ({ email: u.email, owner: false })),
  ]

  return (
    <div className="card">
      <div className="card-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Paired account{allAccounts.length !== 1 ? 's' : ''}
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className={`btn${multiAccount ? '' : ' secondary'}`}
            style={{ fontSize: 11, padding: '2px 10px' }}
            disabled={busy}
            onClick={() => patch({ multiAccount: !multiAccount, ...(multiAccount ? { locked: false } : {}) })}
          >
            {multiAccount ? 'Multi-account' : 'Single account'}
          </button>
          {multiAccount && (
            <button
              className={`btn${locked ? '' : ' secondary'}`}
              style={{ fontSize: 11, padding: '2px 10px', background: locked ? 'var(--err)' : undefined }}
              disabled={busy}
              onClick={() => patch({ locked: !locked })}
              title={locked ? 'Unlock — allow new accounts to join' : 'Lock — no new accounts can join'}
            >
              {locked ? '🔒 Locked' : '🔓 Unlocked'}
            </button>
          )}
        </div>
      </div>

      {allAccounts.map(({ email, owner }) => (
        <div key={email} className="row" style={{ paddingTop: 8, paddingBottom: 8 }}>
          <span className="row-value" style={{ fontFamily: 'inherit', fontSize: 13 }}>
            {email}
            {owner && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>OWNER</span>}
          </span>
          {!owner && (
            <button className="btn secondary" style={{ fontSize: 11, padding: '2px 8px' }} disabled={busy} onClick={() => removeUser(email)}>
              Remove
            </button>
          )}
        </div>
      ))}

      {multiAccount && !locked && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            className="install-input"
            placeholder="Add account by email"
            value={addEmail}
            onChange={e => setAddEmail(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addUser()}
            style={{ fontSize: 13 }}
          />
          <button className="btn" style={{ flexShrink: 0 }} disabled={busy || !addEmail.includes('@')} onClick={addUser}>
            Add
          </button>
        </div>
      )}

      {msg && <div className={`msg ${msg.type}`} style={{ marginTop: 8 }}>{msg.text}</div>}

      {pendingRequests.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--bg-border)' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--warn)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {pendingRequests.length} pending request{pendingRequests.length !== 1 ? 's' : ''}
          </div>
          {pendingRequests.map(r => (
            <div key={r.email} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13, marginBottom: 4 }}>{r.email}</div>
              {r.message && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{r.message}</div>}
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn" style={{ fontSize: 11, padding: '3px 10px' }} disabled={busy} onClick={() => approveRequest(r.email, 'approve')}>Approve</button>
                <button className="btn secondary" style={{ fontSize: 11, padding: '3px 10px' }} disabled={busy} onClick={() => approveRequest(r.email, 'deny')}>Deny</button>
              </div>
            </div>
          ))}
        </div>
      )}
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
          <span className="row-label">Relay</span>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={`badge ${status.relayConnected ? 'ok' : 'err'}`}>
                {status.relayConnected ? '● Connected' : '○ Disconnected'}
              </span>
              {!status.relayConnected && <ReconnectButton />}
            </div>
            {status.relayError && (
              <div style={{ color: 'var(--err)', fontSize: 11, maxWidth: 360, textAlign: 'right', lineHeight: 1.4 }}>
                {status.relayError}
              </div>
            )}
          </div>
        </div>
        <div className="row">
          <span className="row-label">Spinny version</span>
          <span className="row-value">{sysInfo?.version || status.version || '—'}</span>
        </div>
      </div>
      {!status.paired && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: 24 }}>
          Not paired — open the <strong style={{ color: 'var(--accent)' }}>Admin</strong> tab to get your pairing token.
        </div>
      )}
      {status.accountId && <AccessCard ownerEmail={status.accountId} />}
    </>
  )
}

function ModelsTab({ sysInfo, error, downloads }) {
  const [installModel, setInstallModel] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installMsg, setInstallMsg] = useState(null)
  const [progress, setProgress] = useState(null)

  if (error) return <div className="error-banner">Could not connect to local server: {error}</div>
  if (!sysInfo) return <div className="loading">Loading models...</div>

  const activeDownloads = Object.entries(downloads || {}).filter(([, v]) => !v.done)

  async function doInstall(model) {
    const m = model || installModel.trim()
    if (!m) return
    setInstalling(true)
    setProgress(null)
    setInstallMsg({ type: 'info', text: `Connecting…` })
    try {
      const r = await fetch('/api/models/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error || `HTTP ${r.status}`)
      }
      const reader = r.body?.getReader()
      if (!reader) throw new Error('No response stream')
      const decoder = new TextDecoder()
      let buf = ''
      let lastStatus = null
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.replace(/^data: /, '').trim()
          if (!line) continue
          try {
            const evt = JSON.parse(line)
            if (evt.done) {
              if (evt.success) {
                setProgress(100)
                setInstallMsg({ type: 'ok', text: `✓ ${m} installed` })
                setInstallModel('')
              } else {
                setProgress(null)
                setInstallMsg({ type: 'err', text: lastStatus || 'Install failed' })
              }
              setInstalling(false)
            } else if (evt.status) {
              lastStatus = evt.status
              const pct = evt.status.match(/(\d+)%/)
              if (pct) setProgress(parseInt(pct[1]))
              setInstallMsg({ type: 'info', text: evt.status })
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (e) {
      setInstallMsg({ type: 'err', text: e.message })
      setInstalling(false)
    }
  }

  return (
    <>
      {activeDownloads.length > 0 && (
        <div className="card">
          <div className="card-title">Downloading</div>
          {activeDownloads.map(([name, dl]) => (
            <div key={name} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="model-name">{name}</span>
                {dl.progress != null && <span style={{ fontSize: 12, color: 'var(--accent)' }}>{dl.progress}%</span>}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dl.status}</div>
              {dl.progress != null && (
                <div className="dl-progress-wrap">
                  <div className="dl-progress-fill" style={{ width: `${dl.progress}%` }} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
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

function LogsTab() {
  const [lines, setLines] = useState([])
  const [error, setError] = useState(null)
  const bottomRef = React.useRef(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/logs?n=200')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      setLines(d.lines || [])
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 2000)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  const levelColor = { log: 'var(--text)', warn: 'var(--warn)', error: 'var(--err)' }

  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--bg-border)' }}>
        <span className="card-title" style={{ margin: 0 }}>Console</span>
        <button className="btn secondary" style={{ fontSize: 11, padding: '3px 10px' }} onClick={load}>Refresh</button>
      </div>
      {error && <div className="msg err" style={{ margin: 12 }}>{error}</div>}
      <div style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6, overflowY: 'auto', maxHeight: '60vh', padding: '8px 0', background: 'var(--bg)' }}>
        {lines.length === 0 && <div style={{ color: 'var(--text-muted)', padding: '16px' }}>No logs yet.</div>}
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, padding: '1px 16px', borderBottom: '1px solid transparent' }}>
            <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontSize: 11 }}>
              {new Date(l.t).toLocaleTimeString()}
            </span>
            <span style={{ color: levelColor[l.level] || 'var(--text)', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{l.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
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
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 32, lineHeight: 1.6, maxWidth: 360 }}>
        Spinny Local runs on your machine and connects your AI models to the Spinny cloud platform. It manages Ollama models, relays tasks, and keeps your data local.
      </p>
    </div>
  )
}

function ChatTab({ sysInfo }) {
  const [model, setModel] = useState('')
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = React.useRef(null)

  const models = sysInfo?.models || []
  const selectedModel = model || models[0]?.name || ''

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    const text = input.trim()
    if (!text || !selectedModel || streaming) return
    const userMsg = { role: 'user', content: text, id: Date.now() }
    const assistantId = Date.now() + 1
    setMessages(prev => [...prev, userMsg, { role: 'assistant', content: '', id: assistantId }])
    setInput('')
    setStreaming(true)
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selectedModel, messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content })) }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error || `HTTP ${r.status}`)
      }
      const reader = r.body?.getReader()
      if (!reader) throw new Error('No response stream')
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.replace(/^data: /, '').trim()
          if (!line) continue
          try {
            const evt = JSON.parse(line)
            if (evt.error) throw new Error(evt.error)
            if (evt.content) {
              setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: m.content + evt.content } : m))
            }
          } catch (parseErr) {
            if (parseErr.message !== 'Unexpected end of JSON input') throw parseErr
          }
        }
      }
    } catch (e) {
      setMessages(prev => prev.map(m => m.id === (messages.length > 0 ? messages[messages.length - 1]?.id + 1 : 1) ? { ...m, content: `Error: ${e.message}` } : m))
    } finally {
      setStreaming(false)
    }
  }

  if (!sysInfo) return <div className="loading">Loading...</div>
  if (!models.length) return (
    <div className="card">
      <div className="card-title">Chat</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No models installed. Install a model in the Models tab first.</div>
    </div>
  )

  return (
    <div className="card">
      <div className="card-title">Chat</div>
      <select className="model-select" value={selectedModel} onChange={e => setModel(e.target.value)}>
        {models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
      </select>
      <div className="chat-messages">
        {messages.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '24px 0' }}>
            Start a conversation with {selectedModel}
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`chat-bubble-wrap ${m.role}`}>
            <div className={`chat-bubble ${m.role}`}>
              {m.content || (m.role === 'assistant' && streaming ? '▋' : '')}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input-row">
        <textarea
          className="chat-textarea"
          placeholder={`Message ${selectedModel}…`}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          rows={1}
        />
        <button className="btn" onClick={send} disabled={streaming || !input.trim()}>
          {streaming ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

function useStreamedAction(endpoint) {
  const [phase, setPhase] = useState('idle') // idle | running | success | failed | rolledBack | restarting
  const [lines, setLines] = useState([])

  const run = async () => {
    setPhase('running')
    setLines([])
    try {
      const r = await fetch(endpoint, { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const reader = r.body?.getReader()
      if (!reader) throw new Error('No stream')
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.replace(/^data: /, '').trim()
          if (!line) continue
          try {
            const evt = JSON.parse(line)
            if (evt.done) {
              if (evt.restarting) setPhase('restarting')
              else if (evt.rolledBack) setPhase('rolledBack')
              else setPhase(evt.success ? 'success' : 'failed')
            } else if (evt.status) {
              setLines(prev => [...prev, evt.status])
            }
          } catch {}
        }
      }
    } catch (e) {
      setLines(prev => [...prev, 'Error: ' + e.message])
      setPhase('failed')
    }
  }

  return { phase, lines, run, reset: () => { setPhase('idle'); setLines([]) } }
}

function ReconnectWatch({ onBack }) {
  const [secs, setSecs] = useState(0)
  const [reconnected, setReconnected] = useState(false)

  useEffect(() => {
    const tick = setInterval(() => setSecs(s => s + 1), 1000)
    const poll = setInterval(async () => {
      try {
        const r = await fetch('/api/status')
        if (r.ok) { setReconnected(true); clearInterval(poll); clearInterval(tick) }
      } catch {}
    }, 2000)
    return () => { clearInterval(tick); clearInterval(poll) }
  }, [])

  if (reconnected) {
    return (
      <div style={{ textAlign: 'center', padding: '32px 0' }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>✓</div>
        <div style={{ fontSize: 15, color: 'var(--ok)', fontWeight: 600, marginBottom: 16 }}>Node is back online</div>
        <button className="btn" onClick={onBack}>Back to dashboard</button>
      </div>
    )
  }

  return (
    <div style={{ textAlign: 'center', padding: '32px 0' }}>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
        Waiting for node to restart… ({secs}s)
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
        This page will reconnect automatically. Your pairing is safe.
      </div>
    </div>
  )
}

function UpdateTab({ updateInfo: initialUpdateInfo, onUpdated }) {
  const update = useStreamedAction('/api/update/apply')
  const rollback = useStreamedAction('/api/update/rollback')
  const [updateInfo, setUpdateInfo] = React.useState(initialUpdateInfo)
  const [checking, setChecking] = React.useState(false)

  React.useEffect(() => { setUpdateInfo(initialUpdateInfo) }, [initialUpdateInfo])

  async function checkNow() {
    setChecking(true)
    try {
      const r = await fetch('/api/update/check?bust=' + Date.now())
      if (r.ok) setUpdateInfo(await r.json())
    } catch {}
    setChecking(false)
  }

  const active = update.phase !== 'idle' ? update : rollback.phase !== 'idle' ? rollback : null
  const restarting = update.phase === 'restarting' || rollback.phase === 'restarting'

  if (restarting) {
    return (
      <div className="card">
        <div className="card-title">Restarting node…</div>
        <ReconnectWatch onBack={() => { update.reset(); rollback.reset(); onUpdated?.() }} />
      </div>
    )
  }

  const localHash = updateInfo?.localHash
  const remoteHash = updateInfo?.remoteHash
  const remoteMessage = updateInfo?.remoteMessage
  const remoteDate = updateInfo?.remoteDate
  const hasUpdate = updateInfo?.updateAvailable

  const checkBtn = (
    <button className="btn secondary" onClick={checkNow} disabled={checking} style={{ marginLeft: 8 }}>
      {checking ? 'Checking…' : '↻ Check now'}
    </button>
  )

  if (!updateInfo) {
    return (
      <div className="card">
        <div className="card-title">Updates</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Not checked yet</span>
          {checkBtn}
        </div>
      </div>
    )
  }

  if (!hasUpdate) {
    return (
      <div className="card">
        <div className="card-title">Updates</div>
        <div style={{ color: 'var(--ok)', fontSize: 13, marginBottom: 12 }}>✓ Node is up to date</div>
        <div className="row">
          <span className="row-label">Version</span>
          <span className="row-value" style={{ fontFamily: 'monospace', fontSize: 12 }}>{localHash || '—'}</span>
        </div>
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          {checkBtn}
          <button className="btn secondary" onClick={update.run} disabled={update.phase === 'running'}>
            {update.phase === 'running' ? 'Restarting…' : '↺ Force Restart'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="card-title">Update Available</div>

      <div className="row">
        <span className="row-label">Current</span>
        <span className="row-value" style={{ fontFamily: 'monospace', fontSize: 12 }}>{localHash || '—'}</span>
      </div>
      <div className="row">
        <span className="row-label">Latest</span>
        <div style={{ textAlign: 'right' }}>
          <div className="row-value" style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--ok)' }}>{remoteHash || '—'}</div>
          {remoteMessage && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{remoteMessage}</div>}
          {remoteDate && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{new Date(remoteDate).toLocaleString()}</div>}
        </div>
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {checkBtn}
        <button
          className="btn"
          onClick={update.run}
          disabled={update.phase === 'running' || update.phase === 'success' || rollback.phase === 'running'}
        >
          {update.phase === 'running' ? 'Updating…' : '⬆ Update & Restart'}
        </button>
        {(update.phase === 'failed' || update.phase === 'rolledBack') && (
          <button
            className="btn secondary"
            onClick={rollback.run}
            disabled={rollback.phase === 'running'}
          >
            {rollback.phase === 'running' ? 'Rolling back…' : '↩ Rollback & Restart'}
          </button>
        )}
      </div>

      {active && active.lines.length > 0 && (
        <div style={{
          marginTop: 14, background: 'var(--bg)', border: '1px solid var(--bg-border)', borderRadius: 6,
          padding: '10px 14px', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.7,
          maxHeight: 200, overflowY: 'auto', color: 'var(--text-muted)'
        }}>
          {active.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {(update.phase === 'rolledBack') && (
        <div className="msg err" style={{ marginTop: 10 }}>Update failed — automatically rolled back to previous version.</div>
      )}
      {(update.phase === 'failed' && update.phase !== 'rolledBack') && (
        <div className="msg err" style={{ marginTop: 10 }}>Update failed. Use Rollback to restore the previous version.</div>
      )}
      {(rollback.phase === 'rolledBack' || rollback.phase === 'failed') && (
        <div className={`msg ${rollback.phase === 'failed' ? 'err' : 'ok'}`} style={{ marginTop: 10 }}>
          {rollback.phase === 'failed' ? 'Rollback failed — check logs.' : 'Rolled back.'}
        </div>
      )}
    </div>
  )
}

// ── Vault Tab ──────────────────────────────────────────────────────────────
const VAULT_PROVIDERS = [
  { id: 'openai',     label: 'OpenAI',      placeholder: 'sk-...' },
  { id: 'anthropic',  label: 'Anthropic',   placeholder: 'sk-ant-...' },
  { id: 'xai',        label: 'xAI / Grok',  placeholder: 'xai-...' },
  { id: 'openrouter', label: 'OpenRouter',  placeholder: 'sk-or-...' },
  { id: 'github',     label: 'GitHub',      placeholder: 'ghp_...' },
]

function VaultTab() {
  const [keys, setKeys] = useState([])
  const [loading, setLoading] = useState(true)
  const [inputs, setInputs] = useState({})
  const [saving, setSaving] = useState({})
  const [msg, setMsg] = useState({})

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/vault/keys')
      const d = await r.json()
      setKeys(d.keys || [])
    } catch { setKeys([]) }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const save = async (provider) => {
    const key = (inputs[provider] || '').trim()
    if (!key) return
    setSaving(p => ({ ...p, [provider]: true }))
    setMsg(p => ({ ...p, [provider]: '' }))
    try {
      const r = await fetch('/api/vault/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Failed')
      setMsg(p => ({ ...p, [provider]: `✓ Saved — ${d.preview}` }))
      setInputs(p => ({ ...p, [provider]: '' }))
      load()
    } catch (e) {
      setMsg(p => ({ ...p, [provider]: `✗ ${e.message}` }))
    }
    setSaving(p => ({ ...p, [provider]: false }))
  }

  const remove = async (provider) => {
    await fetch(`/api/vault/keys/${provider}`, { method: 'DELETE' })
    setMsg(p => ({ ...p, [provider]: '' }))
    load()
  }

  const stored = new Map(keys.map(k => [k.provider, k]))

  return (
    <div>
      <div className="card">
        <div className="card-title">Local Vault — API Keys</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.6 }}>
          Keys are encrypted with AES-256-GCM and stored on this machine only.
          The master key lives in your OS credential store (Windows DPAPI / macOS Keychain).
          Spinny uses these keys when calling cloud AI providers — they never leave this machine.
        </p>
        {VAULT_PROVIDERS.map(p => {
          const entry = stored.get(p.id)
          return (
            <div key={p.id} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--bg-border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{p.label}</span>
                {entry && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--ok)' }}>● {entry.preview}</span>
                    <button className="btn secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => remove(p.id)}>Remove</button>
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="password"
                  className="chat-textarea"
                  style={{ flex: 1, minHeight: 'auto', padding: '7px 10px', fontSize: 12 }}
                  placeholder={entry ? `Replace current key (${entry.preview})` : p.placeholder}
                  value={inputs[p.id] || ''}
                  onChange={e => setInputs(prev => ({ ...prev, [p.id]: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && save(p.id)}
                />
                <button className="btn" style={{ flexShrink: 0 }} onClick={() => save(p.id)} disabled={saving[p.id] || !inputs[p.id]?.trim()}>
                  {saving[p.id] ? '…' : 'Save'}
                </button>
              </div>
              {msg[p.id] && (
                <div style={{ fontSize: 11, marginTop: 5, color: msg[p.id].startsWith('✓') ? 'var(--ok)' : 'var(--err)' }}>
                  {msg[p.id]}
                </div>
              )}
            </div>
          )
        })}
        {loading && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Loading…</div>}
      </div>
    </div>
  )
}

// ── Admin Tab ──────────────────────────────────────────────────────────────

function AdminTab() {
  const [pairingToken, setPairingToken] = useState(null)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [tokenCopied, setTokenCopied] = useState(false)
  const [config, setConfig] = useState(null)
  const [configBusy, setConfigBusy] = useState(false)
  const [configMsg, setConfigMsg] = useState(null)
  const [maxInput, setMaxInput] = useState('')
  const [tailscale, setTailscale] = useState(null)
  const [tailscaleBusy, setTailscaleBusy] = useState(false)
  const [tailscaleMsg, setTailscaleMsg] = useState(null)

  const fetchPairingToken = useCallback(async () => {
    try {
      const r = await fetch('/pairing/token')
      if (r.ok) setPairingToken(await r.json())
    } catch {}
  }, [])

  const fetchConfig = useCallback(async () => {
    try {
      const r = await fetch('/admin/config')
      if (r.ok) {
        const d = await r.json()
        setConfig(d)
        setMaxInput(String(d.maxPairedAccounts ?? 1))
      }
    } catch {}
  }, [])

  const fetchTailscale = useCallback(async () => {
    try {
      const r = await fetch('/admin/tailscale')
      if (r.ok) setTailscale(await r.json())
    } catch {}
  }, [])

  useEffect(() => {
    fetchPairingToken()
    fetchConfig()
    fetchTailscale()
    const iv = setInterval(fetchPairingToken, 3000)
    return () => clearInterval(iv)
  }, [fetchPairingToken, fetchConfig, fetchTailscale])

  const copyToken = () => {
    if (!pairingToken?.code) return
    navigator.clipboard.writeText(pairingToken.code).then(() => {
      setTokenCopied(true); setTimeout(() => setTokenCopied(false), 2000)
    })
  }

  async function saveConfig(patch) {
    setConfigBusy(true); setConfigMsg(null)
    try {
      const r = await fetch('/admin/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Failed')
      setConfig(d)
      setMaxInput(String(d.maxPairedAccounts ?? 1))
      setConfigMsg({ type: 'ok', text: 'Saved' })
      setTimeout(() => setConfigMsg(null), 2000)
    } catch (e) { setConfigMsg({ type: 'err', text: e.message }) }
    setConfigBusy(false)
  }

  async function connectTailscale() {
    setTailscaleBusy(true); setTailscaleMsg(null)
    try {
      const r = await fetch('/admin/tailscale/connect', { method: 'POST' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Tailscale setup failed')
      setTailscale(d)
      setTailscaleMsg({
        type: 'ok',
        text: d.action === 'opened-install-page'
          ? 'Opened Tailscale download page.'
          : 'Started Tailscale login/setup. Finish the browser prompt, then refresh status.',
      })
      setTimeout(fetchTailscale, 2500)
    } catch (e) {
      setTailscaleMsg({ type: 'err', text: e.message })
    }
    setTailscaleBusy(false)
  }

  function copyTailscaleUrl() {
    if (!tailscale?.nodeUrl) return
    navigator.clipboard.writeText(tailscale.nodeUrl).then(() => {
      setTailscaleMsg({ type: 'ok', text: 'Copied Tailscale node URL.' })
      setTimeout(() => setTailscaleMsg(null), 2000)
    })
  }

  const remaining = pairingToken?.remaining ?? pairingToken?.ttl ?? 60
  const ttl = pairingToken?.ttl ?? 60

  return (
    <>
      <div className="card">
        <div className="card-title">Pairing Token</div>
        {pairingToken && !pairingToken.paired ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <TotpRing remaining={remaining} ttl={ttl} />
              <div style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 700, letterSpacing: '0.18em', flex: 1, color: 'var(--text)' }}>
                {tokenVisible ? (pairingToken.code || '——') : '••••••'}
              </div>
              <button className="btn secondary" onClick={() => setTokenVisible(v => !v)} style={{ fontSize: 16, padding: '6px 10px' }}>
                {tokenVisible ? '🙈' : '👁'}
              </button>
              <button className="btn" onClick={copyToken} disabled={!tokenVisible}>{tokenCopied ? '✓' : 'Copy'}</button>
            </div>
            <div className="pairing-hint" style={{ marginTop: 8 }}>
              Rotates every {ttl}s — enter this code at spinny.au to pair your node.
            </div>
          </>
        ) : (
          <div style={{ color: 'var(--ok)', fontSize: 13 }}>
            ● Node is paired{config?.pairedCount ? ` (${config.pairedCount} account${config.pairedCount !== 1 ? 's' : ''})` : ''}.
          </div>
        )}
      </div>

      {config && (
        <div className="card">
          <div className="card-title">Node Access</div>
          <div className="row">
            <span className="row-label">Multi-account</span>
            <button
              className={`btn${config.multiAccount ? '' : ' secondary'}`}
              style={{ fontSize: 11, padding: '3px 12px' }}
              disabled={configBusy}
              onClick={() => saveConfig({ multiAccount: !config.multiAccount })}
            >
              {config.multiAccount ? 'On' : 'Off'}
            </button>
          </div>
          {config.multiAccount && (
            <div className="row">
              <span className="row-label">Max accounts</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number" min={1} max={50}
                  className="install-input"
                  style={{ width: 64, textAlign: 'center', padding: '4px 8px' }}
                  value={maxInput}
                  onChange={e => setMaxInput(e.target.value)}
                />
                <button className="btn" style={{ fontSize: 11, padding: '3px 12px' }} disabled={configBusy}
                  onClick={() => saveConfig({ maxPairedAccounts: parseInt(maxInput) || 1 })}>
                  Save
                </button>
              </div>
            </div>
          )}
          {config.multiAccount && (
            <div className="row">
              <span className="row-label">Lock new accounts</span>
              <button
                className={`btn${config.locked ? '' : ' secondary'}`}
                style={{ fontSize: 11, padding: '3px 12px', ...(config.locked ? { background: 'var(--err)' } : {}) }}
                disabled={configBusy}
                onClick={() => saveConfig({ locked: !config.locked })}
              >
                {config.locked ? '🔒 Locked' : '🔓 Open'}
              </button>
            </div>
          )}
          {configMsg && <div className={`msg ${configMsg.type}`} style={{ marginTop: 8 }}>{configMsg.text}</div>}
        </div>
      )}

      {tailscale && tailscale.supported && (
        <div className="card">
          <div className="card-title">Tailscale Remote Access</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
            Optional: add this node to your Tailscale network so you can reach the local panel through a private Tailscale IP.
          </p>
          <div className="row">
            <span className="row-label">Tailscale</span>
            <span className={`badge ${tailscale.ip ? 'ok' : tailscale.installed ? '' : 'err'}`}>
              {tailscale.ip ? `Connected: ${tailscale.ip}` : tailscale.installed ? 'Installed' : 'Not installed'}
            </span>
          </div>
          {tailscale.status?.backendState && (
            <div className="row">
              <span className="row-label">State</span>
              <span className="row-value">{tailscale.status.backendState}</span>
            </div>
          )}
          {tailscale.nodeUrl && (
            <div className="row">
              <span className="row-label">Node URL</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                <span className="row-value" style={{ fontFamily: 'monospace', fontSize: 12 }}>{tailscale.nodeUrl}</span>
                <button className="btn secondary" style={{ fontSize: 11, padding: '3px 10px' }} onClick={copyTailscaleUrl}>Copy</button>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn" onClick={connectTailscale} disabled={tailscaleBusy}>
              {tailscaleBusy ? 'Starting...' : tailscale.installed ? 'Connect Tailscale' : 'Install Tailscale'}
            </button>
            <button className="btn secondary" onClick={fetchTailscale}>Refresh status</button>
          </div>
          {tailscaleMsg && <div className={`msg ${tailscaleMsg.type}`} style={{ marginTop: 8 }}>{tailscaleMsg.text}</div>}
        </div>
      )}
    </>
  )
}

const TABS = ['Status', 'Models', 'Chat', 'Vault', 'System', 'Logs', 'Admin', 'Update', 'About']

export function App() {
  const { data: status, error: statusErr } = usePoll('/api/status', 5000)
  const [tab, setTab] = useState('Admin') // default to Admin; switch to Status once paired
  const [tabInitialised, setTabInitialised] = useState(false)

  useEffect(() => {
    if (tabInitialised || !status) return
    setTabInitialised(true)
    if (status.paired) setTab('Status')
  }, [status, tabInitialised])
  const { data: sysInfo, error: sysErr } = usePoll('/api/system', 5000)
  const { data: updateInfo } = usePoll('/api/update/check', 5 * 60 * 1000)
  const { data: dlData } = usePoll('/api/models/downloading', 2000)
  const hasUpdate = updateInfo?.updateAvailable
  const tabs = TABS

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
            {tabs.map(t => (
              <button
                key={t}
                className={`tab-btn${tab === t ? ' active' : ''}${t === 'Update' ? ' update-tab' : ''}`}
                onClick={() => setTab(t)}
              >
                {t === 'Update' ? '⬆ Update' : t}
              </button>
            ))}
          </div>
        </div>
        <div className="content">
          {tab === 'Status' && <StatusTab status={status} sysInfo={sysInfo} error={statusErr} />}
          {tab === 'Models' && <ModelsTab sysInfo={sysInfo} error={sysErr} downloads={dlData || {}} />}
          {tab === 'Chat'   && <ChatTab sysInfo={sysInfo} />}
          {tab === 'Vault'  && <VaultTab />}
          {tab === 'System' && <SystemTab sysInfo={sysInfo} error={sysErr} />}
          {tab === 'Logs'  && <LogsTab />}
          {tab === 'Admin' && <AdminTab />}
          {tab === 'About' && <AboutTab sysInfo={sysInfo} />}
          {tab === 'Update' && <UpdateTab updateInfo={updateInfo} onUpdated={() => setTab('Status')} />}
        </div>
      </div>
    </>
  )
}
