import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadState, saveState } from "./state.js";
import { ensureNodeIdentity, signJson } from "./identity.js";
import { appendSecurityEvent, chainTip, verifySecurityChain } from "./security-log.js";
import { actualManifest, compareManifest, currentCommit, fetchTrustedManifest } from "./release-manifest.js";

let timer = null;

export function processFingerprint() {
  return {
    argv_hash: hash(process.argv.join("\0")),
    cwd_hash: hash(process.cwd()),
    ppid: process.ppid,
    pid: process.pid,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
  };
}

export async function runAttestation({ post = true } = {}) {
  const state = loadState();
  const commit = currentCommit(process.cwd());
  const result = {
    type: "attestation.heartbeat",
    nodeId: state.nodeId,
    issuedAt: new Date().toISOString(),
    nonce: randomNonce(),
    commit,
    manifest_hash: hash(JSON.stringify(actualManifest(process.cwd()))),
    process_fingerprint: processFingerprint(),
    anomalies: unauthorizedChildProcesses(),
    diff: [],
    chain_ok: verifySecurityChain(state.security?.lastPortalChainTip || "").ok,
    chain_tip: chainTip().head || "",
  };
  try {
    const manifest = await fetchTrustedManifest(commit, state.controlUrl);
    result.manifest_hash = hash(JSON.stringify(manifest.files || {}));
    result.diff = compareManifest(process.cwd(), manifest);
  } catch (err) {
    result.anomalies.push(`manifest_unavailable:${err.message}`);
  }
  const status = result.diff.length ? "tampered" : result.anomalies.length ? "drift_detected" : "verified";
  result.type = status === "tampered" ? "tamper.detected" : "attestation.heartbeat";
  appendSecurityEvent("attestation.result", {
    status,
    commit: result.commit,
    manifest_hash: result.manifest_hash,
    diff: result.diff,
    anomalies: result.anomalies,
  });
  saveState({
    ...state,
    security: {
      ...(state.security || {}),
      status,
      tampered: status === "tampered",
      tamperedAt: status === "tampered" ? (state.security?.tamperedAt || new Date().toISOString()) : null,
      quarantined: status === "tampered" ? true : Boolean(state.security?.quarantined),
      lastAttestationAt: new Date().toISOString(),
      lastGoodAttestationAt: status === "verified" ? new Date().toISOString() : state.security?.lastGoodAttestationAt,
      diff: result.diff,
      anomalies: result.anomalies,
      chainTip: result.chain_tip,
    }
  });
  if (post) await postAttestation(result).catch(err => appendSecurityEvent("attestation.post_failed", { error: err.message }));
  return result;
}

export function startRuntimeAttestation() {
  runAttestation().catch(() => {});
  clearInterval(timer);
  timer = setInterval(() => runAttestation().catch(() => {}), 5 * 60 * 1000);
  timer.unref?.();
}

export function isQuarantined() {
  const security = loadState().security || {};
  return Boolean(security.quarantined || security.tampered || security.status === "tampered");
}

export async function postSecurityChainTip() {
  const state = loadState();
  if (!state.paired || !state.nodeId || !state.controlUrl) return { skipped: true };
  const identity = ensureNodeIdentity();
  const payload = {
    type: "security.chain_tip",
    nodeId: state.nodeId,
    issuedAt: new Date().toISOString(),
    nonce: randomNonce(),
    tip: chainTip().head || "",
    entries: chainTip().entries || 0,
    ok: chainTip().ok,
  };
  const base = state.controlUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api/spinny/local-nodes/${encodeURIComponent(state.nodeId)}/security-chain-tip`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature: signJson(identity.privateKey, payload) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`chain tip post failed: HTTP ${res.status}`);
  return res.json().catch(() => ({ ok: true }));
}

async function postAttestation(payload) {
  const state = loadState();
  if (!state.paired || !state.nodeId || !state.controlUrl) return { skipped: true };
  const identity = ensureNodeIdentity();
  const base = state.controlUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api/spinny/local-nodes/${encodeURIComponent(state.nodeId)}/attestation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature: signJson(identity.privateKey, payload) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`attestation post failed: HTTP ${res.status}`);
  return res.json().catch(() => ({ ok: true }));
}

function unauthorizedChildProcesses() {
  try {
    const out = execFileSync(process.platform === "win32" ? "wmic" : "ps", process.platform === "win32"
      ? ["process", "get", "ParentProcessId,CommandLine"]
      : ["-eo", "ppid=,comm="], { encoding: "utf8", timeout: 3000 });
    const allowed = /ollama|node|systray|powershell|sh|bash|git|npm/i;
    return out.split(/\r?\n/).filter(line => line.includes(String(process.pid)) && !allowed.test(line)).slice(0, 10);
  } catch {
    return [];
  }
}

function hash(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function randomNonce() {
  return createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex");
}

