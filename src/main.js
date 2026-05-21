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
import { startSubagentScheduler } from "./subagent-scheduler.js";
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
    let stopRotation = () => {};

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
        stopRotation?.();
      }
    });

    // Start autonomous sub-agent scheduler
    const { monitorEmails, executeEmailAction, sendTelegramNotification, formatTelegramNotification } = await import('./email-vertical.js')
    startSubagentScheduler({ monitorEmails, executeEmailAction, sendTelegramNotification, formatTelegramNotification })

    if (!state.paired) {
      const controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au";
      const ROTATE_MS = 10 * 60 * 1000
      let pairingClaimSeen = false

      function needsMorePairings(s) {
        if (!s.multiAccount) return !s.paired
        return (s.allowedUsers?.length || 0) < (s.maxPairedAccounts || 1)
      }

      async function rotateCode() {
        const s = loadState()
        if (pairingClaimSeen) return
        if (!needsMorePairings(s)) return
        const code = generatePairingCode()
        saveState({ ...s, pairingCode: code, pairingCodeIssuedAt: Date.now() })
        try {
          const r = await fetch(`${controlUrl}/api/spinny/pairing/advertise`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairingCode: code, nodeId: s.nodeId }),
            signal: AbortSignal.timeout(8000),
          })
          console.log(`[relay-pair] advertise ${code} -> ${r.status}`)
        } catch (err) {
          console.error('[relay-pair] advertise failed:', err.message)
        }
      }

      // Fresh code on startup — always regenerate, stale codes are expired in cloud DB
      await rotateCode()
      state = loadState()
      const rotateTimer = setInterval(rotateCode, ROTATE_MS)
      stopRotation = () => {
        const s = loadState()
        if (!needsMorePairings(s)) clearInterval(rotateTimer)
      }

      const code = state.pairingCode;
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


      // Poll spinny.au for claim — when someone enters the code on spinny.au,
      // complete pairing via signed pairNodeDirect (no direct network access needed)
      let pollCount = 0
      const pollTimer = setInterval(async () => {
        pollCount++
        try {
          const { pairingCode: currentCode, nodeId: currentNodeId } = loadState()
          if (!currentCode) { console.log('[relay-pair] poll: no code in state'); return }
          console.log(`[relay-pair] poll #${pollCount} code=${currentCode} nodeId=${currentNodeId.slice(0,8)}…`)
          const r = await fetch(
            `${controlUrl}/api/spinny/pairing/status?code=${currentCode}&nodeId=${currentNodeId}`,
            { signal: AbortSignal.timeout(8000) }
          );
          const body = await r.json();
          console.log(`[relay-pair] poll #${pollCount} → HTTP ${r.status}`, JSON.stringify(body))
          if (!r.ok) { console.error('[relay-pair] poll error:', r.status, body); return; }
          if (body.expired) { console.log('[relay-pair] code expired on cloud — waiting for rotation'); return; }
          if (body.waiting) { console.log('[relay-pair] waiting for user to enter code'); return; }
          if (body.claimed && body.accountEmail) {
            pairingClaimSeen = true
            clearInterval(rotateTimer)
            console.log(`[relay-pair] CLAIMED by ${body.accountEmail} — calling pairNodeDirect…`);
            try {
              const result = await pairNodeDirect({ accountEmail: body.accountEmail, pairingCode: currentCode, controlUrl });
              clearInterval(pollTimer);
              console.log(`[relay-pair] SUCCESS — paired! nodeId=${result.nodeId} accountId=${result.accountId}`);
              pairingResolver?.(result);
            } catch (err) {
              console.error('[relay-pair] pairNodeDirect FAILED:', err.message);
            }
          } else {
            console.log('[relay-pair] unexpected poll response:', JSON.stringify(body))
          }
        } catch (err) {
          console.error('[relay-pair] poll EXCEPTION:', err.message);
        }
      }, 5000);

      // No hard timeout — systemd restarts the service; just wait indefinitely
      const pairingPromise = new Promise(resolve => { pairingResolver = resolve });
      await pairingPromise;
      clearInterval(pollTimer);
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
