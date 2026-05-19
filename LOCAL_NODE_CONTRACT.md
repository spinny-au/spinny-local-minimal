# Spinny Local Node - Contract

spinny-local-minimal is a signed-command executor, privacy enforcement
layer, local memory vault, and inference adapter.

## What this node does
- Accepts signed instructions from Vercel (spinny-ui-web)
- Verifies Ed25519 signatures before executing anything
- Enforces the user's local privacy firewall on every operation
- Runs Ollama inference with whatever system prompt it receives
- Stores and retrieves typed memory objects
- Returns a privacy receipt with every response

## What this node does NOT do
- Interpret user intent
- Decide routing or orchestration strategy
- Rank, score, or select prompts
- Contain proprietary business logic
- Trust unsigned requests for privileged operations

## Contributor boundary
Any PR that adds orchestration logic, intent parsing, prompt strategy,
or business decision-making to this repo will be rejected.
The intelligence lives in the cloud. The execution lives here.

## Tagline
Cloud-taught. Locally owned. Privately executed.
