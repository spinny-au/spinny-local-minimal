#!/usr/bin/env node
import { interceptConsole } from "./log-buffer.js";
interceptConsole();
import { execSync } from 'node:child_process'
import qrcode from 'qrcode-terminal'
import { ensureNodeIdentity } from "./identity.js";
import { ensureVaultKey, Vault } from "./vault.js";
import { pairNode, pairNodeDirect, requestPairing, getPairingRequestStatus, applyPairingRequestApproval } from "./pairing.js";
import { RelayClient, startHealthPush, pushHealthDirect } from "./relay.js";
import { loadState, saveState, generatePairingCode } from "./state.js";
import { runDoctor } from "./doctor.js";
import { startLocalServer } from "./local-server.js";
import { startSubagentScheduler } from "./subagent-scheduler.js"
import { startRelayInfer } from "./relay-infer.js";
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

  } else if (command === "sendhealth") {
    const result = await pushHealthDirect()
    if (result?.skipped) {
      console.log(result.reason || 'node is not paired')
      process.exitCode = 1
    } else {
      console.log('health pushed ok')
    }

  } else if (command === "pairme2") {
    const email = process.argv[3] || readFlag("--email");
    const result = await requestPairing({ targetEmail: email });
    console.log(JSON.stringify(result, null, 2));
    // Poll until approved (up to 3 min) so user sees confirmation immediately.
    // The running daemon will also detect approval via its own poll loop.
    const deadline = Date.now() + 3 * 60_000
    process.stdout.write('\nWaiting for approval at spinny.au')
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000))
      const health = await pushHealthDirect().catch(() => null)
      if (health && !health.skipped) {
        console.log('\nApproved and health pushed — node is now ONLINE.')
        break
      }
      const s = loadState()
      if (s.paired) { console.log(`\nApproved! Paired as ${s.accountId}`); break }
      process.stdout.write('.')
    }
    if (!loadState().paired) console.log('\nNot yet approved. Daemon will keep polling.');

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
    startRelayInfer()

    if (!state.paired) {
      const controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au";
      const ROTATE_MS = 10 * 60 * 1000
      let pairingClaimSeen = false

      function needsMorePairings(s) {
        if (!s.multiAccount) return !s.paired
        return (s.allowedUsers?.length || 0) < (s.maxPairedAccounts || 1)
      }

      async function rotateCode({ force = false, reason = '' } = {}) {
        const s = loadState()
        if (pairingClaimSeen) return
        if (!needsMorePairings(s)) return
        const codeAge = s.pairingCode && s.pairingCodeIssuedAt ? Date.now() - s.pairingCodeIssuedAt : Infinity
        const reuseExisting = !force && codeAge < ROTATE_MS && s.pairingCode
        const code = reuseExisting ? s.pairingCode : generatePairingCode()
        saveState({ ...s, pairingCode: code, pairingCodeIssuedAt: reuseExisting ? s.pairingCodeIssuedAt : Date.now() })
        const identity = ensureNodeIdentity()
        try {
          const r = await fetch(`${controlUrl}/api/spinny/pairing/advertise`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairingCode: code, nodeId: s.nodeId, nodePublicKey: identity.publicKeyDer }),
            signal: AbortSignal.timeout(8000),
          })
          console.log(`[relay-pair] advertise ${code} -> ${r.status}${reason ? ` (${reason})` : ''}`)
        } catch (err) {
          console.error('[relay-pair] advertise failed:', err.message)
        }
      }

      // Reuse existing code if still fresh, otherwise generate new one
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
          const currentState = loadState()
          const {
            pairingCode: currentCode,
            nodeId: currentNodeId,
            pairingRequestId,
            pairingRequestEmail,
          } = currentState
          const logPoll = pollCount === 1 || pollCount % 12 === 0
          if (pairingRequestId) {
            if (logPoll) {
              console.log(`[pairme2] poll #${pollCount} request=${String(pairingRequestId).slice(0, 12)}... email=${pairingRequestEmail || 'unknown'}`)
            }
            const requestStatus = await getPairingRequestStatus({
              requestId: pairingRequestId,
              nodeId: currentNodeId,
              controlUrl,
            })
            if (logPoll || requestStatus.approved || requestStatus.rejected || requestStatus.expired) {
              console.log(`[pairme2] poll #${pollCount} ->`, JSON.stringify(requestStatus))
            }
            if (requestStatus.approved && requestStatus.relaySessionToken) {
              pairingClaimSeen = true
              try {
                const newState = applyPairingRequestApproval(requestStatus, controlUrl)
                clearInterval(rotateTimer)
                clearInterval(pollTimer)
                console.log(`[pairme2] APPROVED by ${newState.accountId} - paired! nodeId=${newState.nodeId}`)
                pairingResolver?.(newState)
              } catch (err) {
                pairingClaimSeen = false
                console.error(`[pairme2] applyPairingRequestApproval failed (will retry): ${err.message}`)
              }
              return
            }
            if (requestStatus.rejected || requestStatus.expired) {
              saveState({
                ...loadState(),
                pairingRequestId: null,
                pairingRequestEmail: null,
                pairingRequestIssuedAt: null,
                pairingRequestExpiresAt: null,
              })
              console.log(`[pairme2] request ${requestStatus.rejected ? 'rejected' : 'expired'} - continuing code pairing`)
            }
          }
          if (!currentCode) { console.log('[relay-pair] poll: no code in state'); return }
          if (logPoll) console.log(`[relay-pair] poll #${pollCount} code=${currentCode} nodeId=${currentNodeId.slice(0,8)}…`)
          const r = await fetch(
            `${controlUrl}/api/spinny/pairing/status?code=${currentCode}&nodeId=${currentNodeId}`,
            { signal: AbortSignal.timeout(8000) }
          );
          const body = await r.json();
          if (logPoll || !r.ok || body.claimed || body.expired) {
            console.log(`[relay-pair] poll #${pollCount} → HTTP ${r.status}`, JSON.stringify(body))
          }
          if (!r.ok) { console.error('[relay-pair] poll error:', r.status, body); return; }
          if (body.expired) {
            console.log('[relay-pair] code expired on cloud — forcing a fresh pairing code now')
            await rotateCode({ force: true, reason: 'cloud expired' })
            return
          }
          if (body.waiting) {
            if (logPoll) console.log('[relay-pair] waiting for user to enter code')
            return
          }
          if (body.claimed && body.relaySessionToken) {
            pairingClaimSeen = true
            try {
              const newState = saveState({
                ...loadState(),
                paired: true,
                accountId: body.accountEmail,
                relaySessionToken: body.relaySessionToken,
                relaySessionExpiresAt: new Date(body.relaySessionExpires * 1000).toISOString(),
                controlPlanePublicKey: body.controlPlanePublicKey || null,
                relayUrl: body.relayUrl || null,
              })
              clearInterval(rotateTimer)
              clearInterval(pollTimer)
              console.log(`[relay-pair] CLAIMED by ${body.accountEmail} — relay session received, saving state…`);
              console.log(`[relay-pair] SUCCESS — paired! nodeId=${newState.nodeId} accountId=${newState.accountId}`);
              pairingResolver?.(newState);
            } catch (err) {
              pairingClaimSeen = false
              console.error(`[relay-pair] saveState failed (will retry): ${err.message}`)
            }
          } else if (body.claimed && body.accountEmail) {
            // Fallback: claimed but no relay token yet (node_public_key not in advertisement)
            console.log(`[relay-pair] CLAIMED by ${body.accountEmail} but no relaySessionToken yet — waiting…`)
          } else {
            console.log('[relay-pair] unexpected poll response:', JSON.stringify(body))
          }
        } catch (err) {
          console.error('[relay-pair] poll EXCEPTION:', err.message);
        }
      }, 5000);

      // Safety net: if pairingResolver was never called but state got updated
      // (e.g. by a CLI pairme2 that applied approval), resolve the promise anyway.
      const pairingPromise = new Promise(resolve => { pairingResolver = resolve });
      const safetyTimer = setInterval(() => {
        if (loadState().paired) {
          clearInterval(safetyTimer)
          pairingResolver?.(loadState())
        }
      }, 10_000)
      await pairingPromise;
      clearInterval(safetyTimer)
      clearInterval(pollTimer);
    } else {
      // Already paired — start tray immediately
      startTray({ getStatus: () => ({ relayConnected }) }).catch(() => {});
    }

    // Push health immediately and every 25s — works without relay WS
    startHealthPush();

    // Start relay — use values from state if available (set during pairing)
    const currentState = loadState();
    const relay = relayInstance = new RelayClient({
      ...(currentState.relayUrl ? { relayUrl: currentState.relayUrl } : {}),
      ...(currentState.controlPlanePublicKey ? { controlPlanePublicKey: currentState.controlPlanePublicKey } : {}),
    });

    relay.on?.('connected', () => { relayConnected = true; relayError = null });
    relay.on?.('disconnected', () => { relayConnected = false; relayError = relay.lastError || 'Relay disconnected' });

    relay.connect().catch((err) => {
      relayConnected = false;
      relayError = err?.message || String(err);
      console.error('[relay] initial connect failed:', relayError);
    });

    console.log("Spinny local node running.");

  } else if (command === "pairingcode") {
    const state = loadState()
    if (state.paired) {
      console.log(JSON.stringify({ paired: true, accountId: state.accountId }, null, 2))
    } else if (state.pairingCode) {
      console.log(JSON.stringify({ paired: false, pairingCode: state.pairingCode, url: `https://spinny.au/?localcode=${state.pairingCode}` }, null, 2))
    } else {
      console.log(JSON.stringify({ paired: false, pairingCode: null, message: 'Start the daemon first: systemctl --user start spinny-local-minimal' }, null, 2))
    }

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
