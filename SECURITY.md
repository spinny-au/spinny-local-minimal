# Spinny Local Node Security

The local node is built to fail closed when its code or control channel cannot
be verified.

## Threat Model

Defended:

- SSH/user edits to tracked source files.
- Replayed node-to-portal messages.
- Unsigned portal commands.
- Poisoned install/update paths.
- Casual disk imaging of local state.
- Unexpected egress attempts from injected code.

Out of scope:

- Cold-boot, JTAG, malicious firmware, or custom hardware attacks. TPM or
  platform attestation is the right v2 path.

## Implemented Layers

- `src/release-manifest.js` verifies signed Ed25519 release manifests and
  SHA-256 file hashes.
- `install.sh` and `scripts/update-worker.mjs` verify the target release before
  install/update activation.
- `src/state.js` migrates plaintext `state.json` to AES-256-GCM `state.enc`;
  the key is derived from the OS-keychain protected node identity.
- `src/attestation.js` runs boot/runtime attestation, records manifest drift,
  and marks the node quarantined when tampered.
- `src/relay-infer.js` refuses to claim relay tasks while quarantined.
- `src/secure-fetch.js` blocks non-allowlisted outbound hosts and logs
  `network.violation`.
- `src/security-log.js` maintains a hash-chained `security.jsonl`.
- `src/recovery.js` captures encrypted forensic snapshots and can Tier 1 restore
  healable files from locally cached, signature-verified releases.

## Release Key

The checked-in public key is a development placeholder. Production releases must
set `SPINNY_RELEASE_PUBLIC_KEY_B64` to the offline maintainer release key. The
private key must never live on the node or portal runtime.

## Privacy

Security telemetry contains paths, hashes, timestamps, counts, event types, and
anomaly names only. It must not include message content, file content, email
bodies, tokens, secrets, API keys, or plaintext PII.
