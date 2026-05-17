# Architecture

## Components

```text
spinny.au          auth, pairing, routing decisions, node registry
Cloudflare DO     persistent WebSocket relay and presence
local node        encrypted vault, node identity, Ollama connector
Ollama            local model runtime
```

## Local Node Responsibilities

- Maintain one local node identity.
- Pair with a Spinny account using an auth-only pairing token.
- Connect to the relay after pairing.
- Receive signed tasks addressed to this node.
- Run local vault retrieval and Ollama inference.
- Stream task results back through the relay.
- Pull local models only after `spinny.au` sends a paired model install task.

## Explicit Non-Responsibilities

- No SaaS routing policy.
- No council/meta-router logic.
- No business-specific prompts.
- No billing, tenancy, or account management.
- No model download before pairing.

## Data Flow

```text
spinny.au UI
  -> user pairs node
  -> spinny.au registers node public key
  -> local node connects to Cloudflare DO relay
  -> UI may request model install
  -> relay sends signed model.install task to node
  -> node asks Ollama to pull the model
```

## API Contract

### Pairing

Local node sends:

```json
{
  "payload": {
    "nodeId": "node_uuid",
    "nodePublicKey": "base64-spki-ed25519",
    "pairingToken": "auth-only-token",
    "client": "spinny-local-minimal",
    "version": "0.1.0"
  },
  "signature": "base64-ed25519-signature-from-node-private-key"
}
```

`spinny.au` returns:

```json
{
  "accountId": "acct_123",
  "relaySessionToken": "short-lived-relay-token",
  "relaySessionExpiresAt": "2026-05-18T00:00:00.000Z"
}
```

### Relay Task Envelope

`spinny.au` sends to Cloudflare relay:

```json
{
  "envelope": {
    "payload": {
      "type": "model.install",
      "taskId": "task_123",
      "nodeId": "node_uuid",
      "issuedAt": "2026-05-18T00:00:00.000Z",
      "params": {
        "model": "llama3.2:3b"
      }
    },
    "signature": "base64-ed25519-signature-from-control-plane-key"
  }
}
```

The local node rejects stale envelopes, duplicate task IDs, tasks for another node, and unsigned tasks unless development mode is explicitly enabled.

### Relay Environment

Cloudflare secrets:

- `SPINNY_CONTROL_URL`: control-plane base URL for verifying node relay sessions.
- `RELAY_SHARED_SECRET`: bearer secret used by the relay when calling `spinny.au`.
- `RELAY_CONTROL_TOKEN`: bearer token required by `spinny.au` when connecting to `/control`.

If those variables are absent, the relay runs in development mode. Set them before production deployment.

## Vault Storage

SQLite contains logical namespaces:

- `context_fabric`
- `memory`
- `wiki`

Values are encrypted independently with AES-256-GCM. Row keys and namespaces are metadata; row values are ciphertext.
