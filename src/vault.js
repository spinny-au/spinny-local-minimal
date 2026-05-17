import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { vaultPath } from "./paths.js";
import { readSecret, writeSecret } from "./secure-store.js";

const KEY_SECRET_NAME = "vault-key-v1";
const KEY_VERSION = 1;

export function ensureVaultKey() {
  const existing = readSecret(KEY_SECRET_NAME);
  if (existing) return Buffer.from(existing, "base64");

  const key = randomBytes(32);
  writeSecret(KEY_SECRET_NAME, key.toString("base64"));
  return key;
}

export class Vault {
  constructor(path = vaultPath(), key = ensureVaultKey()) {
    this.db = new DatabaseSync(path);
    this.key = key;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS encrypted_items (
        namespace TEXT NOT NULL,
        item_key TEXT NOT NULL,
        key_version INTEGER NOT NULL,
        nonce TEXT NOT NULL,
        tag TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, item_key)
      )
    `);
  }

  put(namespace, itemKey, value) {
    const plain = Buffer.from(JSON.stringify(value), "utf8");
    const nonce = randomBytes(12);
    const aad = Buffer.from(`${namespace}:${itemKey}:v${KEY_VERSION}`, "utf8");
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO encrypted_items
      (namespace, item_key, key_version, nonce, tag, ciphertext, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, item_key) DO UPDATE SET
        key_version = excluded.key_version,
        nonce = excluded.nonce,
        tag = excluded.tag,
        ciphertext = excluded.ciphertext,
        updated_at = excluded.updated_at
    `).run(namespace, itemKey, KEY_VERSION, nonce.toString("base64"), tag.toString("base64"), ciphertext.toString("base64"), now, now);
  }

  get(namespace, itemKey) {
    const row = this.db.prepare(`
      SELECT key_version, nonce, tag, ciphertext
      FROM encrypted_items
      WHERE namespace = ? AND item_key = ?
    `).get(namespace, itemKey);
    if (!row) return null;

    const aad = Buffer.from(`${namespace}:${itemKey}:v${row.key_version}`, "utf8");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.nonce, "base64"));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(row.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, "base64")),
      decipher.final()
    ]);
    return JSON.parse(plain.toString("utf8"));
  }

  list(namespace, limit = 20) {
    const rows = this.db.prepare(`
      SELECT item_key
      FROM encrypted_items
      WHERE namespace = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(namespace, limit);
    return rows.map((row) => ({
      key: row.item_key,
      value: this.get(namespace, row.item_key)
    }));
  }

  close() {
    this.db.close();
  }
}
