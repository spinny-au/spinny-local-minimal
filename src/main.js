#!/usr/bin/env node
import { interceptConsole } from "./log-buffer.js";
interceptConsole();
import { execSync } from 'node:child_process'
import qrcode from 'qrcode-terminal'
import { ensureNodeIdentity } from "./identity.js";
import { ensureVaultKey, Vault } from "./vault.js";
import { pairNode } from "./pairing.js";
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

    let relayConnected = false;
    let relayInstance = null;
    let relayError = null;

    // Suppress unhandled rejections from systray2's internal async init —
    // the tray is optional and must never crash the main process.
    process.on('unhandledRejection', () => {});

    // Start local panel server immediately — available before and after pairing
    let pairingResolver = null;
    startLocalServer({
      getRelayStatus: () => relayConnected,
      getRelayError: () => relayError,
      getRelay: () => relayInstance,
      onPaired: (result) => {
        console.log(`\nPaired! Node ID: ${result.nodeId}`);
        console.log("Starting relay connection...\n");
        pairingResolver?.(result);
      }
    });

    if (!state.paired) {
      state = saveState({ ...state, pairingCode: generatePairingCode() });
      const code = state.pairingCode;
      const controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au";
      const pairingUrl = `${controlUrl}/?localcode=${code}`;

      console.log("\n┌──────────────────────────────────────────┐");
      console.log(`│  Pairing code:  ${code.padEnd(25)}│`);
      console.log("│  Go to spinny.au → Settings → Local Node │");
      console.log("│  and enter the code above, or scan QR:   │");
      console.log("└──────────────────────────────────────────┘\n");

      console.log("Scan to pair from your phone or another device:\n");
      qrcode.generate(pairingUrl, { small: true });
      console.log(`\nOr open this URL on any signed-in device:\n${pairingUrl}\n`);
      console.log("Waiting for pairing (5 min timeout)...\n");

      // Start tray AFTER printing QR so a tray crash can't suppress output
      startTray({ getStatus: () => ({ relayConnected }) }).catch(() => {});

      const TIMEOUT_MS = 5 * 60 * 1000;
      const pairingPromise = new Promise(resolve => { pairingResolver = resolve });
      const paired = await Promise.race([
        pairingPromise,
        new Promise(resolve => setTimeout(() => resolve(null), TIMEOUT_MS))
      ]);

      if (!paired) {
        console.log("Pairing timed out. Run 'npm start' again to retry.");
        process.exit(0);
      }
    } else {
      // Already paired — start tray immediately
      startTray({ getStatus: () => ({ relayConnected }) }).catch(() => {});
    }

    // Start relay — use values from state if available (set during pairing)
    const currentState = loadState();
    const relay = relayInstance = new RelayClient({
      ...(currentState.relayUrl ? { relayUrl: currentState.relayUrl } : {}),
      ...(currentState.controlPlanePublicKey ? { controlPlanePublicKey: currentState.controlPlanePublicKey } : {}),
    });

    relay.on?.('connected', () => { relayConnected = true; relayError = null });
    relay.on?.('disconnected', () => { relayConnected = false; relayError = relay.lastError || 'Relay disconnected' });

    relay.connect().catch(() => {});

    console.log("Spinny local node running.");

  } else if (command === "repair") {
    const state = loadState();
    const relayUrl = process.env.SPINNY_RELAY_URL || null;
    const updated = saveState({ ...state, relayUrl });
    console.log(JSON.stringify({ relayUrl: updated.relayUrl || '(will auto-discover on next start)' }, null, 2));

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
