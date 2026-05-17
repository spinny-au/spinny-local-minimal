# Security Notes

## Key Separation

Pairing tokens authenticate setup and relay access. They are never encryption material.

The vault key is random 256-bit key material created locally. It is wrapped by OS secure storage and used only on the local machine.

## Threat Model

This design protects local vault data at rest when an attacker gets the database file without access to the unlocked OS user session.

It does not protect against malware running as the user, an already unlocked machine, compromised Ollama models, or a malicious operating system.

## Node Identity

Each node has an Ed25519 keypair. `spinny.au` should register the node public key and support per-node revocation.

Tasks should be signed by Spinny control-plane keys and addressed to a specific node ID. This repo includes the verification boundary and rejects tasks addressed to a different node.

## Model Installation

No model is installed during local app installation. Model installation happens only after pairing, via an explicit `model.install` task.

The model name is treated as data from the control plane. The local node passes it to Ollama's `/api/pull` endpoint and does not execute shell commands.

## Production Defaults

- Set `SPINNY_CONTROL_PLANE_PUBLIC_KEY`.
- Keep `SPINNY_ALLOW_UNSIGNED_TASKS=0`.
- Keep `SPINNY_ALLOW_INSECURE_FILE_KEY=0`.
- Use short-lived relay session tokens.
- Revoke nodes server-side by node ID.
- Do not put prompt templates, orchestration rules, routing policy, or account logic in this repo.
