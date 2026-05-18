import { EventEmitter } from "node:events";
import { ensureNodeIdentity, signJson, verifyJson } from "./identity.js";
import { loadState } from "./state.js";
import { handleTask } from "./tasks.js";
import { assertFreshIssuedAt, nodeHello } from "./protocol.js";

function derivedRelayUrl(state) {
  if (state?.relayUrl) return state.relayUrl
  if (process.env.SPINNY_RELAY_URL) return process.env.SPINNY_RELAY_URL
  const ctrl = state?.controlUrl || process.env.SPINNY_CONTROL_URL || ''
  if (ctrl) {
    const ws = ctrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://').replace(/\/$/, '')
    return `${ws}/api/local-nodes/relay/node`
  }
  return null
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

async function fetchRelayUrl(state) {
  // Ask the control plane — works for nodes paired before relayUrl was stored
  const ctrl = state?.controlUrl || process.env.SPINNY_CONTROL_URL || 'https://spinny.au'
  const base = ctrl.replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/api/spinny/local-nodes/relay-url`)
    if (res.ok) {
      const data = await res.json()
      if (data?.relayUrl) return data.relayUrl
    }
  } catch {}
  return 'wss://relay.spinny.au/node'
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
    const url = this.relayUrl || state.relayUrl || process.env.SPINNY_RELAY_URL || await fetchRelayUrl(state) || derivedRelayUrl(state);
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
    });

    socket.addEventListener("message", async (event) => {
      try {
        const envelope = JSON.parse(event.data);
        logRelay(`received message type=${envelope?.payload?.type || envelope?.type || "unknown"}`);
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
      this.send({ type: "node.ping", issuedAt: new Date().toISOString() });
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
