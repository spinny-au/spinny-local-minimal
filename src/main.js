#!/usr/bin/env node
import { interceptConsole } from "./log-buffer.js";
interceptConsole();
import { execSync } from 'node:child_process'
import qrcode from 'qrcode-terminal'
import { ensureNodeIdentity } from "./identity.js";
import { ensureVaultKey, Vault } from "./vault.js";
import { pairNode, pairNodeDirect } from "./pairing.js";
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
      // Keep same code across restarts so systemd restarts don't change it mid-pairing
      if (!state.pairingCode) state = saveState({ ...state, pairingCode: generatePairingCode() });
      const code = state.pairingCode;
      const controlUrl = process.env.SPINNY_CONTROL_URL || "https://www.spinny.au";
      const pairingUrl = `${controlUrl}/?localcode=${code}`;

      // Detect Tailscale IP for remote-node users
      let tailscaleIp = null;
      try {
        const { execSync: _exec } = await import('node:child_process');
        const ts = _exec('tailscale ip --4', { timeout: 3000, stdio: 'pipe' }).toString().trim();
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ts)) tailscaleIp = ts;
      } catch {}

      const nodePort = 47821;
      const nodeAddr = tailscaleIp ? `${tailscaleIp}:${nodePort}` : `localhost:${nodePort}`;

      console.log("\n╔══════════════════════════════════════════════════╗");
      console.log(`║  Pairing code:  ${code.padEnd(33)}║`);
      console.log(`║  Node address:  ${nodeAddr.padEnd(33)}║`);
      console.log("╠══════════════════════════════════════════════════╣");
      console.log("║  Pair at spinny.au — no node address needed      ║");
      console.log("║  (relay pairing — works from any browser)        ║");
      console.log("╚══════════════════════════════════════════════════╝\n");
      qrcode.generate(pairingUrl, { small: true });
      console.log(`QR URL: ${pairingUrl}\n`);
      console.log("Waiting for pairing...\n");

      startTray({ getStatus: () => ({ relayConnected }) }).catch(() => {});

      // Advertise pairing code to spinny.au so users can pair without direct access
      const advertise = async () => {
        try {
          const r = await fetch(`${controlUrl}/api/spinny/pairing/advertise`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairingCode: code, nodeId: state.nodeId }),
            signal: AbortSignal.timeout(10000),
          });
          console.log(`[relay-pair] advertise → ${r.status}`);
        } catch (err) {
          console.error('[relay-pair] advertise failed:', err.message);
        }
      };
      await advertise();
      const advertiseTimer = setInterval(advertise, 4 * 60 * 1000); // refresh before 15min TTL

      // Poll spinny.au for claim — when someone enters the code on spinny.au,
      // complete pairing via signed pairNodeDirect (no direct network access needed)
      const pollTimer = setInterval(async () => {
        try {
          const r = await fetch(
            `${controlUrl}/api/spinny/pairing/status?code=${code}&nodeId=${state.nodeId}`,
            { signal: AbortSignal.timeout(8000) }
          );
          const body = await r.json();
          if (!r.ok) { console.error('[relay-pair] poll error:', r.status, body); return; }
          if (body.claimed && body.accountEmail) {
            console.log(`[relay-pair] claimed by ${body.accountEmail} — completing pairing…`);
            try {
              const result = await pairNodeDirect({ accountEmail: body.accountEmail, controlUrl });
              clearInterval(pollTimer);
              clearInterval(advertiseTimer);
              console.log(`[relay-pair] paired! Account: ${result.accountId}`);
              pairingResolver?.(result);
            } catch (err) {
              console.error('[relay-pair] pairNodeDirect failed:', err.message);
            }
          }
        } catch (err) {
          console.error('[relay-pair] poll failed:', err.message);
        }
      }, 5000);

      // No hard timeout — systemd restarts the service; just wait indefinitely
      const pairingPromise = new Promise(resolve => { pairingResolver = resolve });
      await pairingPromise;
      clearInterval(pollTimer);
      clearInterval(advertiseTimer);
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
