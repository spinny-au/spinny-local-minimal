import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ensureNodeIdentity, signJson } from "./identity.js";
import { loadState, saveState } from "./state.js";
import { getSystemInfo } from "./system-info.js";

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

export async function requestPairing({ targetEmail, controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au" }) {
  const email = String(targetEmail || "").toLowerCase().trim();
  if (!email || !email.includes("@")) throw new Error("Valid email is required");

  const identity = ensureNodeIdentity();
  const state = saveState(loadState());
  const health = getSystemInfo();
  const requestId = `preq_${randomBytes(18).toString("base64url")}`;
  const payload = {
    type: "node.pairing_request",
    requestId,
    targetEmail: email,
    nodeId: state.nodeId,
    nodeName: state.nodeName || health.nodeName || null,
    hostname: health.hostname || null,
    nodePublicKey: identity.publicKeyDer,
    health,
    client: "spinny-local-minimal",
    version: "0.1.0",
    issuedAt: new Date().toISOString(),
    ...gitFingerprint(),
  };
  const signature = signJson(identity.privateKey, payload);
  const base = controlUrl.replace(/\/$/, "");

  const response = await fetch(`${base}/api/spinny/pairing/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature }),
    signal: AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(async () => ({ error: await response.text().catch(() => "") }));
  if (!response.ok) {
    throw new Error(`Pairing request failed: ${response.status} ${body.error || JSON.stringify(body)}`);
  }

  if (body.alreadyPaired) {
    saveState({
      ...state,
      paired: state.paired || false,
      accountId: state.accountId || email,
      nodePublicKey: identity.publicKeyDer,
      controlUrl: base,
    });
    return {
      ok: true,
      alreadyPaired: true,
      targetEmail: email,
      nodeId: state.nodeId,
      message: body.message || "node already paired",
    };
  }

  saveState({
    ...state,
    pairingRequestId: requestId,
    pairingRequestEmail: email,
    pairingRequestIssuedAt: Date.now(),
    pairingRequestExpiresAt: body.expiresAt || null,
    nodePublicKey: identity.publicKeyDer,
    controlUrl: base,
  });

  return {
    ok: true,
    requestId,
    targetEmail: email,
    nodeId: state.nodeId,
    expiresAt: body.expiresAt || null,
  };
}

export async function getPairingRequestStatus({
  requestId,
  nodeId,
  controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au",
}) {
  if (!requestId || !nodeId) return { waiting: false, expired: true };
  const base = controlUrl.replace(/\/$/, "");
  const url = `${base}/api/spinny/pairing/requests/status?requestId=${encodeURIComponent(requestId)}&nodeId=${encodeURIComponent(nodeId)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const body = await response.json().catch(async () => ({ error: await response.text().catch(() => "") }));
  if (!response.ok) throw new Error(`Pairing request poll failed: ${response.status} ${body.error || JSON.stringify(body)}`);
  return body;
}

export async function getPairingCodeStatus({
  pairingCode,
  nodeId,
  controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au",
}) {
  if (!pairingCode || !nodeId) return { waiting: false, expired: true };
  const base = controlUrl.replace(/\/$/, "");
  const url = `${base}/api/spinny/pairing/status?code=${encodeURIComponent(String(pairingCode).toUpperCase())}&nodeId=${encodeURIComponent(nodeId)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const body = await response.json().catch(async () => ({ error: await response.text().catch(() => "") }));
  if (!response.ok) throw new Error(`Pairing code poll failed: ${response.status} ${body.error || JSON.stringify(body)}`);
  return body;
}

export function applyPairingCodeClaim(body, controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au") {
  const state = loadState();
  const identity = ensureNodeIdentity();
  const accountEmail = String(body.accountEmail || "").toLowerCase().trim();
  const relaySessionToken = String(body.relaySessionToken || "");
  const relaySessionExpires = Number(body.relaySessionExpires || 0);
  if (!accountEmail || !accountEmail.includes("@")) throw new Error("Pairing claim is missing account email");
  if (!relaySessionToken || !relaySessionExpires) throw new Error("Pairing claim is missing relay session");

  return saveState({
    ...state,
    paired: true,
    accountId: accountEmail,
    pairedAt: new Date().toISOString(),
    relaySessionToken,
    relaySessionExpiresAt: new Date(relaySessionExpires * 1000).toISOString(),
    nodePublicKey: identity.publicKeyDer,
    controlPlanePublicKey: body.controlPlanePublicKey || null,
    relayUrl: body.relayUrl || null,
    controlUrl: controlUrl.replace(/\/$/, ""),
    pairingCode: null,
    pairingCodeIssuedAt: null,
    pairingRequestId: null,
    pairingRequestEmail: null,
    pairingRequestIssuedAt: null,
    pairingRequestExpiresAt: null,
  });
}

export function applyPairingRequestApproval(body, controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au") {
  const state = loadState();
  const identity = ensureNodeIdentity();
  const accountEmail = String(body.accountEmail || "").toLowerCase().trim();
  const relaySessionToken = String(body.relaySessionToken || "");
  const relaySessionExpires = Number(body.relaySessionExpires || 0);
  if (!accountEmail || !accountEmail.includes("@")) throw new Error("Pairing approval is missing account email");
  if (!relaySessionToken || !relaySessionExpires) throw new Error("Pairing approval is missing relay session");

  const existingUsers = Array.isArray(state.allowedUsers) ? state.allowedUsers : [];
  const hasUser = existingUsers.some((u) => u?.email === accountEmail);
  return saveState({
    ...state,
    paired: true,
    accountId: accountEmail,
    pairedAt: new Date().toISOString(),
    relaySessionToken,
    relaySessionExpiresAt: new Date(relaySessionExpires * 1000).toISOString(),
    nodePublicKey: identity.publicKeyDer,
    controlPlanePublicKey: body.controlPlanePublicKey || null,
    relayUrl: body.relayUrl || null,
    controlUrl: controlUrl.replace(/\/$/, ""),
    pairingRequestId: null,
    pairingRequestEmail: null,
    pairingRequestIssuedAt: null,
    pairingRequestExpiresAt: null,
    allowedUsers: hasUser
      ? existingUsers
      : [{ email: accountEmail, role: existingUsers.length ? "member" : "owner", addedAt: new Date().toISOString() }, ...existingUsers],
  });
}

export async function applyPendingPairingRequestApproval({
  controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au",
} = {}) {
  const state = loadState();
  if (state.paired) return { applied: false, reason: "already paired", state };
  if (!state.pairingRequestId || !state.nodeId) {
    return { applied: false, reason: "no pending pairing request", state };
  }

  const status = await getPairingRequestStatus({
    requestId: state.pairingRequestId,
    nodeId: state.nodeId,
    controlUrl: state.controlUrl || controlUrl,
  });
  if (status.approved && status.relaySessionToken) {
    const next = applyPairingRequestApproval(status, state.controlUrl || controlUrl);
    return { applied: true, reason: "approved", state: next };
  }
  return {
    applied: false,
    reason: status.rejected ? "rejected" : status.expired ? "expired" : "waiting",
    status,
    state,
  };
}

export async function applyPendingPairingCodeClaim({
  controlUrl = process.env.SPINNY_CONTROL_URL || "https://spinny.au",
} = {}) {
  const state = loadState();
  if (state.paired) return { applied: false, reason: "already paired", state };
  if (!state.pairingCode || !state.nodeId) {
    return { applied: false, reason: "no pending pairing code", state };
  }

  const status = await getPairingCodeStatus({
    pairingCode: state.pairingCode,
    nodeId: state.nodeId,
    controlUrl: state.controlUrl || controlUrl,
  });
  if (status.claimed && status.relaySessionToken) {
    const next = applyPairingCodeClaim(status, state.controlUrl || controlUrl);
    return { applied: true, reason: "claimed", state: next };
  }
  return {
    applied: false,
    reason: status.expired ? "expired" : "waiting",
    status,
    state,
  };
}
