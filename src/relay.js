import { EventEmitter } from "node:events";
import { ensureNodeIdentity, signJson, verifyJson } from "./identity.js";
import { loadState, saveState } from "./state.js";
import { handleTask } from "./tasks.js";
import { assertFreshIssuedAt, nodeHello } from "./protocol.js";
import { getSystemInfo } from "./system-info.js";
import { applyPendingPairingCodeClaim, applyPendingPairingRequestApproval } from "./pairing.js";

function derivedRelayUrl(state) {
  if (process.env.SPINNY_RELAY_URL) return process.env.SPINNY_RELAY_URL
  return 'wss://relay.spinny.au/node'
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

export async function pushHealthDirect() {
  let state = loadState()
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
  if (!state.paired || !state.nodeId) return { ok: false, skipped: true, reason: 'node is not paired' }
  const base = (state.controlUrl || 'https://spinny.au').replace(/\/$/, '')
  const headers = { 'content-type': 'application/json' }
  if (state.relaySessionToken) {
    headers['authorization'] = `Bearer ${state.relaySessionToken}`
    headers['x-spinny-node-id'] = state.nodeId
  }
  const response = await fetch(`${base}/api/spinny/local-nodes/${encodeURIComponent(state.nodeId)}/health`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ health: getSystemInfo() }),
    signal: AbortSignal.timeout(8000),
  })
  const body = await response.json().catch(() => ({}))
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
      health: getSystemInfo()
    }
  } catch (error) {
    return {
      type: "node.health",
      issuedAt: new Date().toISOString(),
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
      try {
        const envelope = JSON.parse(event.data);
        const msgType = envelope?.payload?.type || envelope?.type || "unknown";
        logRelay(`received message type=${msgType}`);
        if (typeof msgType === "string" && msgType.startsWith("relay.")) return;
        const task = this.verifyEnvelope(envelope, state.nodeId);
        await handleTask(task, { send: (message) => this.sendSigned(message, identity.privateKey) });
      } catch (error) {
        this.lastError = error.message;
        logRelay(`message handling failed: ${error.message}`);
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
