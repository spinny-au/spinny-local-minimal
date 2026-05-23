import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash, sign } from "node:crypto";
import { securityLogPath } from "./paths.js";
import { canonicalJson, ensureNodeIdentity } from "./identity.js";

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function appendSecurityEvent(type, metadata = {}) {
  const prev = chainTip().head || "";
  const entry = {
    ts: new Date().toISOString(),
    type,
    metadata: sanitizeTelemetry(metadata),
    prev_hash: prev,
  };
  entry.entry_hash = sha256Hex(canonicalJson(entry));
  appendFileSync(securityLogPath(), `${canonicalJson(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  return entry;
}

export function verifySecurityChain(expectedTip = "") {
  if (!existsSync(securityLogPath())) return { ok: expectedTip === "", entries: 0, head: "", expected: expectedTip || undefined };
  let prev = "";
  let entries = 0;
  for (const line of readFileSync(securityLogPath(), "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { return { ok: false, reason: "invalid_json", entries, head: prev }; }
    const supplied = entry.entry_hash;
    const unsigned = { ...entry };
    delete unsigned.entry_hash;
    const actual = sha256Hex(canonicalJson(unsigned));
    if (supplied !== actual) return { ok: false, reason: "entry_hash_mismatch", entries, head: prev };
    if ((entry.prev_hash || "") !== prev) return { ok: false, reason: "prev_hash_mismatch", entries, head: prev };
    prev = supplied;
    entries += 1;
  }
  if (expectedTip && expectedTip !== prev) return { ok: false, reason: "expected_tip_mismatch", entries, head: prev, expected: expectedTip };
  return { ok: true, entries, head: prev };
}

export function chainTip() {
  return verifySecurityChain();
}

export function signedChainTip() {
  const identity = ensureNodeIdentity();
  const tip = chainTip();
  const payload = {
    type: "security.chain_tip",
    nodeId: null,
    issuedAt: new Date().toISOString(),
    nonce: randomNonce(),
    tip: tip.head || "",
    entries: tip.entries || 0,
    ok: Boolean(tip.ok),
  };
  return {
    payload,
    signature: sign(null, Buffer.from(canonicalJson(payload)), identity.privateKey).toString("base64"),
  };
}

export function sanitizeTelemetry(value) {
  const blocked = new Set(["body", "content", "message", "email", "text", "prompt", "response", "file_content", "token", "secret", "api_key", "password"]);
  if (Array.isArray(value)) return value.slice(0, 50).map(sanitizeTelemetry);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      blocked.has(String(key).toLowerCase()) ? "[redacted]" : sanitizeTelemetry(item)
    ]));
  }
  if (typeof value === "string" && value.length > 256) return `${value.slice(0, 253)}...`;
  return value;
}

function randomNonce() {
  return createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 32);
}

