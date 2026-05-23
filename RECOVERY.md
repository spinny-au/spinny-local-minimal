# Local Node Recovery

Recovery is cache-backed and forensic-first.

```mermaid
stateDiagram-v2
  normal --> tampered: attestation diff
  tampered --> quarantine: relay tasks stop
  quarantine --> forensic_snapshot: encrypted evidence
  forensic_snapshot --> heal_tier_1: <=3 healable files
  heal_tier_1 --> normal: re-attest verified
  heal_tier_1 --> tier_3_prompt: failed / install drift
```

## Verified Cache

`src/release-manifest.js` caches releases under:

```text
~/.spinny-local/releases/<commit>/
  manifest.json
  files/
  verified_at
```

Only releases that passed manifest signature and file-hash verification can be
used as a healing source.

## Forensics

`src/recovery.js` writes quarantine bundles under:

```text
~/.spinny-local/quarantine/<timestamp>/
  evidence.json
  files/*.enc
```

File bodies are encrypted with a key derived from the node identity. The portal
receives metadata only.

## Never Auto-Healed

- `state.enc` / legacy `state.json`
- `.env`
- `vault.sqlite`
- `security.jsonl`
- identity keys
- quarantine bundles

Tier 3/Tier 4 reinstall or factory reset must remain user-confirmed.
