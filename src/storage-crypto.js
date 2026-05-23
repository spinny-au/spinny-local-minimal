import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const HEADER = "spinny-enc-v1:";

export function deriveStorageKey(keyMaterial, info = "spinny-storage-v1") {
  const material = Buffer.isBuffer(keyMaterial) ? keyMaterial : Buffer.from(String(keyMaterial || ""), "utf8");
  if (!material.length) throw new Error("storage key material is required");
  return Buffer.from(hkdfSync("sha256", material, Buffer.from("spinny-local-storage"), Buffer.from(info), 32));
}

export function encryptText(plainText, key, aad = "spinny-state") {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${HEADER}${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
}

export function decryptText(sealed, key, aad = "spinny-state") {
  if (!String(sealed || "").startsWith(HEADER)) throw new Error("unknown encrypted state header");
  const raw = Buffer.from(sealed.slice(HEADER.length), "base64");
  if (raw.length < 29) throw new Error("encrypted state is truncated");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function encryptJson(value, key, aad = "spinny-json") {
  return encryptText(JSON.stringify(value), key, aad);
}

export function decryptJson(sealed, key, aad = "spinny-json") {
  return JSON.parse(decryptText(sealed, key, aad));
}

export function isEncryptedValue(value) {
  return String(value || "").startsWith(HEADER);
}

