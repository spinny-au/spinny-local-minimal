#!/usr/bin/env node
import { ensureNodeIdentity } from "./identity.js";
import { ensureVaultKey, Vault } from "./vault.js";
import { pairNode } from "./pairing.js";
import { startPairingServer } from "./pairing-server.js";
import { RelayClient } from "./relay.js";
import { loadState, saveState, generatePairingCode } from "./state.js";
import { runDoctor } from "./doctor.js";
import { startLocalServer } from "./local-server.js";
import { startTray } from "./tray.js";

const command = process.argv[2] || "start";

try {
  if (command === "status") {
    const identity = ensureNodeIdentity();
    ensureVaultKey();
    const state = saveState({
      ...loadState(),
      nodePublicKey: loadState().nodePublicKey || identity.publicKeyDer
    });
    const vault = new Vault();
    vault.close();
    console.log(JSON.stringify({
      nodeId: state.nodeId,
      paired: state.paired,
      accountId: state.accountId,
      hasNodePublicKey: Boolean(state.nodePublicKey),
      vault: "ready"
    }, null, 2));

  } else if (command === "pair") {
    const token = readFlag("--token");
    const state = await pairNode({ token });
    console.log(JSON.stringify({
      paired: state.paired,
      nodeId: state.nodeId,
      accountId: state.accountId
    }, null, 2));

  } else if (command === "start") {
    ensureNodeIdentity();
    ensureVaultKey();
    let state = loadState();

    if (!state.paired) {
      // Generate and persist a pairing code if not already set
      if (!state.pairingCode) {
        state = saveState({ ...state, pairingCode: generatePairingCode() });
      }
      const code = state.pairingCode;
      const controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au";
      const pairingUrl = `${controlUrl}/?localcode=${code}`;

      console.log("\n┌──────────────────────────────────────────┐");
      console.log(`│  Pairing code:  ${code.padEnd(25)}│`);
      console.log("│  Go to spinny.au → Settings → Local Node │");
      console.log("│  and enter the code above, or scan QR:   │");
      console.log("└──────────────────────────────────────────┘\n");

      const paired = await startPairingServer({
        pairingPageUrl: pairingUrl,
        onPaired: (s) => {
          console.log(`\nPaired! Node ID: ${s.nodeId}`);
          console.log("Starting relay connection...\n");
        }
      });
      if (!paired) {
        console.log("Pairing timed out. Run 'npm start' again to retry.");
        process.exit(0);
      }
    }

    // Track relay connectivity
    let relayConnected = false;

    // Start the local panel server
    startLocalServer({ getRelayStatus: () => relayConnected });

    // Start relay — use values from state if available (set during pairing)
    const currentState = loadState();
    const relay = new RelayClient({
      ...(currentState.relayUrl ? { relayUrl: currentState.relayUrl } : {}),
      ...(currentState.controlPlanePublicKey ? { controlPlanePublicKey: currentState.controlPlanePublicKey } : {}),
    });

    relay.on?.('connected', () => { relayConnected = true });
    relay.on?.('disconnected', () => { relayConnected = false });

    relay.connect();

    // Start system tray (optional — wrapped in try/catch inside startTray)
    startTray({ getStatus: () => ({ relayConnected }) });

    console.log("Spinny local node running.");

  } else if (command === "doctor") {
    const checks = await runDoctor();
    console.log(JSON.stringify(checks, null, 2));
    if (checks.some((check) => !check.ok && check.name !== "pairing" && check.name !== "ollama")) {
      process.exitCode = 1;
    }

  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) return null;
  return process.argv[index + 1];
}
