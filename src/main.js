#!/usr/bin/env node
import { ensureNodeIdentity } from "./identity.js";
import { ensureVaultKey, Vault } from "./vault.js";
import { pairNode } from "./pairing.js";
import { startPairingServer } from "./pairing-server.js";
import { RelayClient } from "./relay.js";
import { loadState, saveState } from "./state.js";
import { runDoctor } from "./doctor.js";

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
    const state = loadState();

    if (!state.paired) {
      const controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au";
      const paired = await startPairingServer({
        pairingPageUrl: `${controlUrl}/pair?node=localhost:${47821}`,
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

    // Start relay
    const relay = new RelayClient();
    relay.connect();
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
