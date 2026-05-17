# spinny-local-minimal

Minimal local companion node for Spinny.

## Prerequisites

- **Node.js 22.5+** — [nodejs.org](https://nodejs.org)
- **Ollama** — [ollama.com](https://ollama.com)

Both must be installed before running the installer or any commands.

This repo is intentionally small and public-safe. It contains the local plumbing only:

- Pairing with `spinny.au`
- Per-node Ed25519 identity
- Cloudflare Durable Object WebSocket relay client
- AES-256-GCM encrypted SQLite vault
- Ollama connector
- Model install task hook after successful pairing

It does **not** contain Spinny orchestration, council logic, routing policy, prompts, product logic, billing, or business IP.

## Lifecycle

1. User installs and starts the local node.
2. Local node generates:
   - a random 256-bit vault key
   - a per-node Ed25519 keypair
3. Vault/key material is wrapped by OS secure storage:
   - Windows: DPAPI through PowerShell secure string APIs
   - macOS: Keychain through `security`
   - Linux: Secret Service through `secret-tool`
4. User pairs the node with `spinny.au`.
5. After pairing succeeds, `spinny.au` UI may send a signed model install task.
6. Local node pulls the requested model through Ollama.

No model is downloaded during install. Model management is initiated from the `spinny.au` UI after pairing.

## Quick Start

```powershell
# 1. Clone and enter the repo
git clone https://github.com/foreverdada6126/spinny-local-minimal.git
cd spinny-local-minimal

# 2. Check everything is ready
npm run doctor

# 3. Get a pairing token from spinny.au → Settings → Local Node → Create pairing token
npm run pair -- --token <pairing-token-from-spinny-au>

# 4. Start the relay connection
npm start
```

The SQLite API is still experimental in Node, so the scripts run with `--experimental-sqlite`.

## Commands

```powershell
npm run status
npm run doctor
npm run pair -- --token <token>
npm start
```

## Install On Login

Windows:

```powershell
.\scripts\install-windows.ps1
```

macOS:

```bash
bash scripts/install-macos.sh
```

Linux systemd user service:

```bash
bash scripts/install-linux.sh
```

These are intentionally simple MVP installers. They copy the repo to a user-local app directory and register a startup command.

## Relay

The Cloudflare Durable Object relay lives in [relay/worker.js](relay/worker.js).

Deploy outline:

```bash
cd relay
npx wrangler deploy
```

The relay exposes:

- `/node?accountId=<id>` for local nodes
- `/control?accountId=<id>` for `spinny.au`
- `/health` for uptime checks

The relay is intentionally dumb. It forwards signed envelopes and tracks presence. It does not perform Spinny routing policy or task business logic.

## Security Boundary

The pairing token is for authentication only. It is never used as an encryption key.

Local vault encryption uses a random 256-bit key generated on the device and wrapped by OS secure storage. SQLite stores encrypted blobs only.

Production task delivery requires `SPINNY_CONTROL_PLANE_PUBLIC_KEY`. Development can set `SPINNY_ALLOW_UNSIGNED_TASKS=1`, but production should never do that.

See [docs/architecture.md](docs/architecture.md) and [docs/security.md](docs/security.md).
