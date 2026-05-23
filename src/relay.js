import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { ensureNodeIdentity, signJson, verifyJson } from "./identity.js";
import { loadState, saveState } from "./state.js";
import { handleTask } from "./tasks.js";
import { assertFreshIssuedAt, nodeHello } from "./protocol.js";
import { getSystemInfo } from "./system-info.js";
import { applyPendingPairingCodeClaim, applyPendingPairingRequestApproval, requestPairing } from "./pairing.js";
import { appendSecurityEvent } from "./security-log.js";

let _lastTokenRenewalAttempt = 0
let _renewalInProgress = false

const CANONICAL_RELAY_URL = 'wss://spinny-local-relay.spinny-au.workers.dev/node'
const CANONICAL_CONTROL_URL = 'https://www.spinny.au'
const KNOWN_BAD_RELAY_URLS = new Set(['wss://relay.spinny.au/node'])

// Force the www subdomain — spinny.au redirects to www.spinny.au, which strips
// the Authorization header on the redirect. Every fetch from the node MUST go
// straight to www.spinny.au.
function canonicalControlUrl(url) {
  if (!url) return CANONICAL_CONTROL_URL
  const trimmed = url.replace(/\/$/, '')
  if (trimmed === 'https://spinny.au' || trimmed === 'http://spinny.au') return CANONICAL_CONTROL_URL
  return trimmed
}

// Self-heal nodes whose state.relayUrl got rewritten to a dead endpoint by a
// previous bad deploy, and whose state.controlUrl is missing the www prefix.
;(() => {
  try {
    const s = loadState()
    const updates = {}
    if (s.relayUrl && KNOWN_BAD_RELAY_URLS.has(s.relayUrl)) {
      updates.relayUrl = CANONICAL_RELAY_URL
    }
    const canonicalCtrl = canonicalControlUrl(s.controlUrl)
    if (s.controlUrl !== canonicalCtrl) {
      updates.controlUrl = canonicalCtrl
    }
    if (Object.keys(updates).length > 0) {
      saveState({ ...s, ...updates })
      for (const [k, v] of Object.entries(updates)) console.log(`[relay] auto-corrected ${k} → ${v}`)
    }
  } catch {}
})()

function derivedRelayUrl(state) {
  if (process.env.SPINNY_RELAY_URL) return process.env.SPINNY_RELAY_URL
  return CANONICAL_RELAY_URL
}

function relayUrlForState(url, state) {
  if (!url || !state?.accountId) return url
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'relay.spinny.au') return url
    if (!parsed.searchParams.get('accountId')) {
      parsed.searchParams.set('accountId', state.accountId)
    }
    return parsed.toString()
  } catch {
    return url
  }
}

function logRelay(message, detail = null) {
  if (detail == null) console.log(`[relay] ${message}`)
  else console.log(`[relay] ${message}`, detail)
}

function safeReason(event) {
  if (!event) return ''
  if (typeof event.reason === 'string') return event.reason
  return ''
}

function isInternalHostname(url) {
  try {
    const { hostname } = new URL(url)
    const host = hostname.toLowerCase()
    if (!host.includes('.')) return true
    const parts = host.split('.').map((part) => Number.parseInt(part, 10))
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false
    if (parts[0] === 10) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    return false
  } catch {
    return false
  }
}

function skipInternalRelayUrl(url, target = 'control plane') {
  if (!url || !isInternalHostname(url)) return false
  logRelay(`skipping internal relay URL ${url} - falling back to ${target}`)
  return true
}

function isLegacyVpsRelayUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.pathname === '/api/local-nodes/relay/node'
  } catch {
    return false
  }
}

function skipLegacyVpsRelayUrl(url, target = 'Cloudflare relay') {
  if (!url || !isLegacyVpsRelayUrl(url)) return false
  logRelay(`skipping legacy VPS relay URL ${url} - falling back to ${target}`)
  return true
}

export async function attemptReconnect({ controlUrl, force = false } = {}) {
  const state = loadState()
  if (!force && (state.paired || !state.nodeId)) return { reconnected: false }
  if (force && !state.nodeId) return { reconnected: false }
  const identity = ensureNodeIdentity()
  const base = (controlUrl || state.controlUrl || process.env.SPINNY_CONTROL_URL || 'https://spinny.au').replace(/\/$/, '')
  const payload = {
    nodeId: state.nodeId,
    nodePublicKey: identity.publicKeyDer,
    issuedAt: new Date().toISOString(),
  }
  try {
    const res = await fetch(`${base}/api/spinny/local-nodes/reconnect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload, signature: signJson(identity.privateKey, payload) }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      console.log(`[relay-reconnect] failed: ${body.error || res.status}`)
      return { reconnected: false }
    }
    const data = await res.json()
    saveState({
      ...state,
      paired: true,
      accountId: data.accountId,
      relaySessionToken: data.relaySessionToken,
      relaySessionExpiresAt: data.relaySessionExpiresAt,
      relayUrl: data.relayUrl || state.relayUrl,
    })
    console.log(`[relay-reconnect] reconnected as ${data.accountId}`)
    return { reconnected: true }
  } catch (err) {
    console.log(`[relay-reconnect] error: ${err.message}`)
    return { reconnected: false }
  }
}

export async function pushHealthDirect() {
  let state = loadState()
  if (!state.paired && state.nodeId) {
    try {
      const r = await attemptReconnect({ controlUrl: state.controlUrl })
      if (r.reconnected) state = loadState()
    } catch {}
  }
  // Proactive token renewal: renew if the relay session token expires within
  // 30 minutes, OR if expiresAt is unknown (legacy paired nodes without the
  // timestamp), OR if the token itself is missing. The node's Ed25519 key pair
  // is the source of truth — the relay session token is just a cache.
  if (state.paired && state.nodeId) {
    const expiresAt = state.relaySessionExpiresAt ? new Date(state.relaySessionExpiresAt).getTime() : 0
    const now = Date.now()
    const tokenNearExpiry = expiresAt < now + 30 * 60 * 1000
    const tokenMissing = !state.relaySessionToken
    if ((tokenNearExpiry || tokenMissing) && now - _lastTokenRenewalAttempt > 5 * 60 * 1000) {
      _lastTokenRenewalAttempt = now
      console.log(`[relay] renewing session token (${tokenMissing ? 'missing' : 'near expiry'})`)
      try {
        const r = await attemptReconnect({ controlUrl: state.controlUrl, force: true })
        if (r.reconnected) { state = loadState(); console.log('[relay] relay session token renewed') }
        else console.log('[relay] session token renewal failed — falling back to next cycle')
      } catch (err) {
        console.log(`[relay] session token renewal error: ${err.message}`)
      }
    }
  }
  if (!state.paired && state.pairingRequestId) {
    try {
      const pending = await applyPendingPairingRequestApproval({ controlUrl: state.controlUrl || process.env.SPINNY_CONTROL_URL || 'https://spinny.au' })
      if (pending.applied) state = pending.state
    } catch (err) {
      console.error(`[pairme2] pending approval check failed: ${err.message}`)
    }
  }
  if (!state.paired && state.pairingCode) {
    try {
      const pending = await applyPendingPairingCodeClaim({ controlUrl: state.controlUrl || process.env.SPINNY_CONTROL_URL || 'https://spinny.au' })
      if (pending.applied) state = pending.state
    } catch (err) {
      console.error(`[relay-pair] pending code claim check failed: ${err.message}`)
    }
  }
  if (!state.paired && state.accountId && String(state.accountId).includes("@")) {
    try {
      const repaired = await requestPairing({
        targetEmail: state.accountId,
        controlUrl: state.controlUrl || process.env.SPINNY_CONTROL_URL || 'https://spinny.au',
      })
      if (repaired.alreadyPaired) state = loadState()
    } catch (err) {
      console.error(`[relay-pair] already-paired repair failed: ${err.message}`)
    }
  }
  if (!state.paired || !state.nodeId) return { ok: false, skipped: true, reason: 'node is not paired' }
  const base = (state.controlUrl || 'https://spinny.au').replace(/\/$/, '')
  const headers = { 'content-type': 'application/json' }
  if (state.relaySessionToken) {
    headers['authorization'] = `Bearer ${state.relaySessionToken}`
    headers['x-spinny-node-id'] = state.nodeId
  }
  const identity = ensureNodeIdentity()
  const payload = {
    type: 'node.health',
    nodeId: state.nodeId,
    issuedAt: new Date().toISOString(),
    nonce: cryptoNonce(),
    health: getSystemInfo(),
  }
  const response = await fetch(`${base}/api/spinny/local-nodes/${encodeURIComponent(state.nodeId)}/health`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ payload, signature: signJson(identity.privateKey, payload) }),
    signal: AbortSignal.timeout(8000),
  })
  const body = await response.json().catch(() => ({}))
  // Server actively rejected our token — renew immediately and retry once.
  // This covers the case where local state thinks the token is valid for days
  // but the server has revoked it or its hash no longer matches.
  if (response.status === 401 && state.relaySessionToken && !_renewalInProgress) {
    _renewalInProgress = true
    console.log('[relay] health push rejected (401) — forcing token renewal')
    try {
      const r = await attemptReconnect({ controlUrl: state.controlUrl, force: true })
      if (r.reconnected) {
        console.log('[relay] token renewed after 401 — retrying health push')
        _renewalInProgress = false
        return pushHealthDirect()
      }
      console.log('[relay] 401 token renewal failed — server-side credentials are gone, re-pair required')
    } finally { _renewalInProgress = false }
  }
  if (!response.ok) {
    const msg = body?.error || body?.detail || `HTTP ${response.status}`
    throw new Error(`health push failed: ${msg}`)
  }
  return { ok: true, status: response.status, body }
}

export function startHealthPush() {
  pushHealthDirect().catch(() => {})
  setInterval(() => pushHealthDirect().catch(() => {}), 25_000).unref()
}

function healthMessage() {
  try {
    return {
      type: "node.health",
      issuedAt: new Date().toISOString(),
      nonce: cryptoNonce(),
      health: getSystemInfo()
    }
  } catch (error) {
    return {
      type: "node.health",
      issuedAt: new Date().toISOString(),
      nonce: cryptoNonce(),
      health: { error: error.message || "Failed to collect system health" }
    }
  }
}

async function fetchRelayUrl(state) {
  // Ask the control plane — works for nodes paired before relayUrl was stored
  const ctrl = state?.controlUrl || process.env.SPINNY_CONTROL_URL || 'https://spinny.au'
  const base = ctrl.replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/api/spinny/local-nodes/relay-url`)
    if (res.ok) {
      const data = await res.json()
      if (
        data?.relayUrl
        && !skipInternalRelayUrl(data.relayUrl, 'derived control-plane URL')
        && !skipLegacyVpsRelayUrl(data.relayUrl, 'derived Cloudflare relay')
      ) return data.relayUrl
    }
  } catch {}
  return null
}

async function resolveRelayUrl(state, explicitRelayUrl) {
  if (process.env.SPINNY_RELAY_URL) return relayUrlForState(process.env.SPINNY_RELAY_URL, state)
  if (
    explicitRelayUrl
    && !skipInternalRelayUrl(explicitRelayUrl, 'control plane')
    && !skipLegacyVpsRelayUrl(explicitRelayUrl, 'control plane')
  ) return relayUrlForState(explicitRelayUrl, state)
  if (
    state?.relayUrl
    && !skipInternalRelayUrl(state.relayUrl, 'control plane')
    && !skipLegacyVpsRelayUrl(state.relayUrl, 'control plane')
  ) return relayUrlForState(state.relayUrl, state)
  if (state?.relayUrl && (isInternalHostname(state.relayUrl) || isLegacyVpsRelayUrl(state.relayUrl))) {
    saveState({ ...state, relayUrl: null })
  }
  return relayUrlForState(await fetchRelayUrl(state) || derivedRelayUrl(state), state)
}

export class RelayClient extends EventEmitter {
  constructor({
    relayUrl,
    controlPlanePublicKey = process.env.SPINNY_CONTROL_PLANE_PUBLIC_KEY,
    allowUnsignedTasks = process.env.SPINNY_ALLOW_UNSIGNED_TASKS === "1",
    reconnect = true
  } = {}) {
    super();
    this.relayUrl = relayUrl || null;
    this.controlPlanePublicKey = controlPlanePublicKey;
    this.allowUnsignedTasks = allowUnsignedTasks;
    this.reconnect = reconnect;
    this.socket = null;
    this.reconnectAttempt = 0;
    this.heartbeat = null;
    this.seenTasks = new Set();
    this.lastError = null;
    this.openedAt = 0;
  }

  async connect() {
    const state = loadState();
    if (!state.paired) throw new Error("Pair node before connecting to relay");
    const identity = ensureNodeIdentity();
    const url = await resolveRelayUrl(state, this.relayUrl);
    this.relayUrl = url; // cache for reconnects
    logRelay(`connecting to ${url}`);
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.openedAt = Date.now();
      this.lastError = null;
      this.emit("connected");
      const payload = nodeHello({
        state,
        relaySessionToken: state.relaySessionToken,
        nodePublicKey: state.nodePublicKey
      });
      logRelay("socket open");
      logRelay("sending node.hello", {
        ...payload,
        relaySessionToken: payload.relaySessionToken ? `<${payload.relaySessionToken.length} chars>` : null
      });
      socket.send(JSON.stringify({ payload, signature: signJson(identity.privateKey, payload) }));
      this.startHeartbeat();
      this.send(healthMessage());
      pushHealthDirect().catch(() => {});
    });

    socket.addEventListener("message", async (event) => {
      let msgType = "unknown";
      try {
        const envelope = JSON.parse(event.data);
        msgType = envelope?.payload?.type || envelope?.type || "unknown";
        logRelay(`received message type=${msgType}`);
        if (typeof msgType === "string" && msgType.startsWith("relay.")) return;
        const task = this.verifyEnvelope(envelope, state.nodeId);
        await handleTask(task, { send: (message) => this.sendSigned(message, identity.privateKey) });
      } catch (error) {
        this.lastError = error.message;
        logRelay(`message handling failed: ${error.message}`);
        appendSecurityEvent("security.protocol_violation", { error: error.message, message_type: msgType });
        this.sendSigned({ type: "task.error", message: error.message, issuedAt: new Date().toISOString() }, identity.privateKey);
      }
    });

    socket.addEventListener("close", (event) => {
      const reason = safeReason(event);
      const detail = `code=${event?.code ?? "unknown"}${reason ? ` reason=${reason}` : ""}`;
      this.lastError = `Relay closed: ${detail}`;
      logRelay(`socket close ${detail}`);
      if (event?.code === 1008) {
        // Unauthorized — relay rejected our session token (node was revoked/purged).
        // Clear paired state so the node goes back to pairing mode.
        this.lastError = "Relay rejected session — node was revoked. Clearing paired state.";
        console.warn(`[relay] ${this.lastError}`);
        try {
          const s = loadState();
          saveState({
            ...s,
            paired: false,
            relaySessionToken: null,
            relaySessionExpiresAt: null,
            accountId: null,
            pairingCode: null,
            pairingCodeIssuedAt: null,
            pairingRequestId: null,
            pairingRequestEmail: null,
          });
          console.log('[relay] paired state cleared — restart required to re-pair');
        } catch (err) {
          console.error('[relay] failed to clear state:', err.message);
        }
        this.reconnect = false; // stop reconnecting — need user to re-pair
        this.emit("disconnected");
        return;
      }
      if (this.openedAt && Date.now() - this.openedAt < 3000) {
        this.lastError = "Relay closed immediately after hello - session token may be expired. Re-pair may be required.";
        console.warn(`[relay] ${this.lastError}`);
      }
      this.emit("disconnected");
      this.scheduleReconnect();
    });
    socket.addEventListener("error", (event) => {
      const message = event?.message || event?.error?.message || "WebSocket error";
      this.lastError = message;
      logRelay(`socket error: ${message}`);
    });

    return socket;
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ payload }));
  }

  sendSigned(payload, privateKey = ensureNodeIdentity().privateKey) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ payload, signature: signJson(privateKey, payload) }));
  }

  verifyEnvelope(envelope, nodeId) {
    if (!envelope?.payload) throw new Error("Malformed relay envelope");
    if (envelope.payload.nodeId !== nodeId) throw new Error("Envelope targets a different node");
    assertFreshIssuedAt(envelope.payload.issuedAt);
    if (envelope.payload.taskId) {
      if (this.seenTasks.has(envelope.payload.taskId)) throw new Error("Duplicate taskId rejected");
      this.seenTasks.add(envelope.payload.taskId);
      if (this.seenTasks.size > 500) this.seenTasks.clear();
    }
    if (this.controlPlanePublicKey) {
      if (!envelope.signature) throw new Error("Missing control-plane signature");
      if (!verifyJson(this.controlPlanePublicKey, envelope.payload, envelope.signature)) {
        throw new Error("Invalid control-plane signature");
      }
    } else if (!this.allowUnsignedTasks) {
      throw new Error("Missing SPINNY_CONTROL_PLANE_PUBLIC_KEY; refusing unsigned task");
    }
    return envelope.payload;
  }

  startHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      this.send(healthMessage());
      pushHealthDirect().catch(() => {});
    }, 25_000);
  }

  scheduleReconnect() {
    clearInterval(this.heartbeat);
    if (!this.reconnect) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt);
    const attempt = this.reconnectAttempt + 1;
    this.reconnectAttempt += 1;
    logRelay(`reconnect attempt ${attempt} scheduled in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
  }
}

function cryptoNonce() {
  return randomBytes(16).toString("hex");
}
