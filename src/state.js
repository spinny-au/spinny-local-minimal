import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { statePath } from "./paths.js";
import { ensureNodeIdentity } from "./identity.js";

const DEFAULT_STATE = {
  nodeId: null,
  paired: false,
  accountId: null,
  pairingCode: null,
  relaySessionToken: null,
  relaySessionExpiresAt: null,
  relayUrl: null,
  controlUrl: null,
  nodePublicKey: null,
  createdAt: null,
  updatedAt: null
};

export function generatePairingCode() {
  // 6-char alphanumeric, easy to type: e.g. "XK4C92"
  return randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

export function loadState() {
  if (!existsSync(statePath())) {
    return { ...DEFAULT_STATE };
  }
  return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(statePath(), "utf8")) };
}

export function saveState(state) {
  const next = {
    ...DEFAULT_STATE,
    ...state,
    updatedAt: new Date().toISOString()
  };
  if (!next.nodeId) {
    const { publicKeyDer } = ensureNodeIdentity();
    next.nodeId = `node_${createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 32)}`;
  }
  if (!next.createdAt) {
    next.createdAt = next.updatedAt;
  }
  writeFileSync(statePath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
