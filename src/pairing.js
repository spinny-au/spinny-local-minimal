import { execSync } from "node:child_process";
import { ensureNodeIdentity, signJson } from "./identity.js";
import { loadState, saveState } from "./state.js";

function gitFingerprint() {
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf8', timeout: 3000 }).trim()
    const commit = execSync('git rev-parse HEAD', { encoding: 'utf8', timeout: 3000 }).trim()
    return { gitRemote: remote, gitCommit: commit }
  } catch {
    return { gitRemote: null, gitCommit: null }
  }
}

export async function pairNodeDirect({ accountEmail, pairingCode, controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au" }) {
  if (!accountEmail) throw new Error("accountEmail is required");
  const identity = ensureNodeIdentity();
  const state = saveState(loadState());
  const payload = {
    nodeId: state.nodeId,
    nodeName: state.nodeName || null,
    nodePublicKey: identity.publicKeyDer,
    accountEmail,
    pairingCode: pairingCode || state.pairingCode || null,
    client: "spinny-local-minimal",
    version: "0.1.0",
    ...gitFingerprint(),
  };
  const signature = signJson(identity.privateKey, payload);

  const response = await fetch(`${controlUrl.replace(/\/$/, "")}/api/spinny/local-nodes/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature })
  });
  if (!response.ok) {
    throw new Error(`Pairing failed: ${response.status} ${await response.text()}`);
  }
  const result = await response.json();

  return saveState({
    ...state,
    paired: true,
    accountId: result.accountId,
    relaySessionToken: result.relaySessionToken,
    relaySessionExpiresAt: result.relaySessionExpiresAt,
    nodePublicKey: identity.publicKeyDer,
    controlPlanePublicKey: result.controlPlanePublicKey || null,
    relayUrl: result.relayUrl || null,
    controlUrl: controlUrl || null,
  });
}

export async function pairNode({ token, controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au" }) {
  if (!token) throw new Error("Pairing token is required");
  const identity = ensureNodeIdentity();
  const state = saveState(loadState());
  const payload = {
    nodeId: state.nodeId,
    nodeName: state.nodeName || null,
    nodePublicKey: identity.publicKeyDer,
    pairingToken: token,
    client: "spinny-local-minimal",
    version: "0.1.0",
    ...gitFingerprint(),
  };
  const signature = signJson(identity.privateKey, payload);

  const response = await fetch(`${controlUrl.replace(/\/$/, "")}/api/spinny/local-nodes/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature })
  });
  if (!response.ok) {
    throw new Error(`Pairing failed: ${response.status} ${await response.text()}`);
  }
  const result = await response.json();

  return saveState({
    ...state,
    paired: true,
    accountId: result.accountId,
    relaySessionToken: result.relaySessionToken,
    relaySessionExpiresAt: result.relaySessionExpiresAt,
    nodePublicKey: identity.publicKeyDer,
    controlPlanePublicKey: result.controlPlanePublicKey || null,
    relayUrl: result.relayUrl || null,
    controlUrl: controlUrl || null,
  });
}
