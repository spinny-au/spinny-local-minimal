import { ensureNodeIdentity, signJson, verifyJson } from "./identity.js";
import { loadState } from "./state.js";
import { handleTask } from "./tasks.js";
import { assertFreshIssuedAt, nodeHello } from "./protocol.js";

function defaultRelayUrl(state) {
  if (state?.relayUrl) return state.relayUrl
  if (process.env.SPINNY_RELAY_URL) return process.env.SPINNY_RELAY_URL
  // Derive from the control URL used during pairing (stored in state)
  const ctrl = state?.controlUrl || process.env.SPINNY_CONTROL_URL || ''
  if (ctrl) {
    const ws = ctrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://').replace(/\/$/, '')
    return `${ws}/api/local-nodes/relay/node`
  }
  return 'wss://relay.spinny.au/node'
}

export class RelayClient {
  constructor({
    relayUrl,
    controlPlanePublicKey = process.env.SPINNY_CONTROL_PLANE_PUBLIC_KEY,
    allowUnsignedTasks = process.env.SPINNY_ALLOW_UNSIGNED_TASKS === "1",
    reconnect = true
  } = {}) {
    this.relayUrl = relayUrl;
    this.controlPlanePublicKey = controlPlanePublicKey;
    this.allowUnsignedTasks = allowUnsignedTasks;
    this.reconnect = reconnect;
    this.socket = null;
    this.reconnectAttempt = 0;
    this.heartbeat = null;
    this.seenTasks = new Set();
  }

  connect() {
    const state = loadState();
    if (!state.paired) throw new Error("Pair node before connecting to relay");
    const identity = ensureNodeIdentity();
    const url = this.relayUrl || defaultRelayUrl(state);
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      const payload = nodeHello({
        state,
        relaySessionToken: state.relaySessionToken,
        nodePublicKey: state.nodePublicKey
      });
      socket.send(JSON.stringify({ payload, signature: signJson(identity.privateKey, payload) }));
      this.startHeartbeat();
    });

    socket.addEventListener("message", async (event) => {
      try {
        const envelope = JSON.parse(event.data);
        const task = this.verifyEnvelope(envelope, state.nodeId);
        await handleTask(task, { send: (message) => this.sendSigned(message, identity.privateKey) });
      } catch (error) {
        this.sendSigned({ type: "task.error", message: error.message, issuedAt: new Date().toISOString() }, identity.privateKey);
      }
    });

    socket.addEventListener("close", () => this.scheduleReconnect());
    socket.addEventListener("error", () => this.scheduleReconnect());

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
    this.reconnectAttempt += 1;
    setTimeout(() => this.connect(), delay);
  }
}
