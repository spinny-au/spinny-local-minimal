export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (!["/node", "/control"].includes(url.pathname)) {
      return new Response("not found", { status: 404 });
    }

    const accountId = url.searchParams.get("accountId") || "global";
    const id = env.NODE_RELAY.idFromName(accountId);
    const relay = env.NODE_RELAY.get(id);
    return relay.fetch(request);
  }
};

export class NodeRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.nodes = new Map();
    this.controlSockets = new Set();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/control" && !isControlAuthorized(request, this.env)) {
      return new Response("unauthorized", { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (url.pathname === "/node") this.attachNode(server);
    if (url.pathname === "/control") this.attachControl(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  attachNode(socket) {
    let nodeId = null;
    let verified = false;
    const pending = [];

    socket.addEventListener("message", (event) => {
      let envelope;
      try {
        envelope = JSON.parse(event.data);
      } catch {
        socket.send(JSON.stringify({ payload: { type: "relay.error", message: "invalid json" } }));
        return;
      }

      if (envelope.payload?.type === "node.hello") {
        nodeId = envelope.payload.nodeId;
        this.verifyNodeHello(envelope).then((ok) => {
          if (!ok) {
            socket.send(JSON.stringify({ payload: { type: "relay.error", message: "unauthorized node session" } }));
            socket.close(1008, "unauthorized");
            return;
          }
          verified = true;
          this.nodes.set(nodeId, socket);
          this.broadcastControl({ type: "relay.presence", nodeId, status: "online" });
          for (const e of pending) {
            if (e.payload?.type === "node.health") this.recordNodeHealth(nodeId, e.payload).catch(() => {});
            this.broadcastControl({ type: "node.message", nodeId, envelope: e });
          }
          pending.length = 0;
        });
        return;
      }

      if (!verified) {
        pending.push(envelope);
        return;
      }

      if (this.nodes.get(nodeId) !== socket) {
        socket.send(JSON.stringify({ payload: { type: "relay.error", message: "node not authenticated" } }));
        return;
      }

      if (envelope.payload?.type === "node.health") {
        this.recordNodeHealth(nodeId, envelope.payload).catch(() => {});
      }
      this.broadcastControl({ type: "node.message", nodeId, envelope });
    });

    socket.addEventListener("close", () => {
      if (!nodeId) return;
      this.nodes.delete(nodeId);
      this.broadcastControl({ type: "relay.presence", nodeId, status: "offline" });
    });
  }

  async verifyNodeHello(envelope) {
    const env = this.env;
    if (!env.SPINNY_CONTROL_URL || !env.RELAY_SHARED_SECRET) return true;
    const response = await fetch(`${env.SPINNY_CONTROL_URL.replace(/\/$/, "")}/api/spinny/local-nodes/relay-session/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.RELAY_SHARED_SECRET}`
      },
      body: JSON.stringify(envelope)
    });
    return response.ok;
  }

  async recordNodeHealth(nodeId, payload) {
    const env = this.env;
    if (!env.SPINNY_CONTROL_URL) return;
    const headers = { "content-type": "application/json" };
    if (env.RELAY_SHARED_SECRET) {
      headers.authorization = `Bearer ${env.RELAY_SHARED_SECRET}`;
    }
    await fetch(`${env.SPINNY_CONTROL_URL.replace(/\/$/, "")}/api/spinny/local-nodes/${encodeURIComponent(nodeId)}/health`, {
      method: "POST",
      headers,
      body: JSON.stringify({ health: payload.health || null })
    });
  }

  attachControl(socket) {
    this.controlSockets.add(socket);
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        socket.send(JSON.stringify({ type: "relay.error", message: "invalid json" }));
        return;
      }
      const nodeId = message.envelope?.payload?.nodeId || message.nodeId;
      const nodeSocket = this.nodes.get(nodeId);
      if (!nodeSocket) {
        socket.send(JSON.stringify({ type: "relay.delivery", nodeId, status: "offline" }));
        return;
      }
      nodeSocket.send(JSON.stringify(message.envelope));
      socket.send(JSON.stringify({ type: "relay.delivery", nodeId, status: "sent" }));
    });
    socket.addEventListener("close", () => this.controlSockets.delete(socket));
  }

  broadcastControl(message) {
    for (const socket of this.controlSockets) {
      try {
        socket.send(JSON.stringify(message));
      } catch {
        this.controlSockets.delete(socket);
      }
    }
  }
}

function isControlAuthorized(request, env) {
  if (!env.RELAY_CONTROL_TOKEN) return true;
  return request.headers.get("authorization") === `Bearer ${env.RELAY_CONTROL_TOKEN}`;
}
