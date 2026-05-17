import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readSecret, writeSecret } from "./secure-store.js";

const SECRET_NAME = "node-ed25519-private-key";

export function ensureNodeIdentity() {
  const existing = readSecret(SECRET_NAME);
  if (existing) return fromPrivateDer(existing);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateDer = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  writeSecret(SECRET_NAME, privateDer);
  return {
    privateKey,
    publicKey,
    publicKeyDer: publicKey.export({ type: "spki", format: "der" }).toString("base64")
  };
}

export function signJson(privateKey, payload) {
  const body = canonicalJson(payload);
  return sign(null, Buffer.from(body), privateKey).toString("base64");
}

export function verifyJson(publicKeyDer, payload, signature) {
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeyDer, "base64"),
    type: "spki",
    format: "der"
  });
  return verify(null, Buffer.from(canonicalJson(payload)), publicKey, Buffer.from(signature, "base64"));
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fromPrivateDer(privateDer) {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateDer, "base64"),
    type: "pkcs8",
    format: "der"
  });
  const publicKey = createPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    publicKeyDer: publicKey.export({ type: "spki", format: "der" }).toString("base64")
  };
}
