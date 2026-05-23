import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { releasesPath } from "./paths.js";
import { canonicalJson } from "./identity.js";

export const RELEASE_SCHEMA = "spinny.release-manifest.v1";
export const DEFAULT_RELEASE_PUBLIC_KEY_B64 = "MCowBQYDK2VwAyEAa/ilY4N+r3s/jksXqFIaO0VA25AZgmzvxSg4kEt9KwQ=";

const EXCLUDED_PARTS = new Set([".git", "node_modules", "dist", ".pytest_cache", "__pycache__"]);
const EXCLUDED_NAMES = new Set([".env", "state.json", "state.enc", "vault.sqlite", "security.jsonl"]);
const EXCLUDED_SUFFIXES = [".log", ".sqlite", ".db", ".enc", ".jsonl"];

export function releasePublicKeys() {
  const envKeys = String(process.env.SPINNY_RELEASE_PUBLIC_KEY_B64 || "").split(/[;,]/).map(x => x.trim()).filter(Boolean);
  return [DEFAULT_RELEASE_PUBLIC_KEY_B64, ...envKeys];
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function currentCommit(repoRoot = process.cwd()) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function trackedFiles(repoRoot = process.cwd()) {
  try {
    return execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
      .split(/\r?\n/).map(line => line.trim()).filter(Boolean).filter(path => !excluded(path));
  } catch {
    return walkFiles(repoRoot).filter(path => !excluded(path));
  }
}

export function actualManifest(repoRoot = process.cwd(), files = trackedFiles(repoRoot)) {
  const out = {};
  for (const file of files) {
    const full = join(repoRoot, file);
    if (existsSync(full) && statSync(full).isFile() && !excluded(file)) out[file.replaceAll("\\", "/")] = sha256File(full);
  }
  return out;
}

export function verifyManifestSignature(manifest, publicKeys = releasePublicKeys()) {
  if (!manifest || manifest.schema !== RELEASE_SCHEMA || !manifest.signature) return false;
  const unsigned = { ...manifest };
  delete unsigned.signature;
  const payload = Buffer.from(canonicalJson(unsigned));
  const sig = Buffer.from(manifest.signature, "base64");
  for (const keyB64 of publicKeys) {
    try {
      const key = createPublicKey({ key: Buffer.from(keyB64, "base64"), type: "spki", format: "der" });
      if (verify(null, payload, key, sig)) return true;
    } catch {}
  }
  return false;
}

export function compareManifest(repoRoot, manifest) {
  const expected = manifest?.files || {};
  const actual = actualManifest(repoRoot, Object.keys(expected));
  const diff = [];
  for (const [path, expectedSha] of Object.entries(expected).sort()) {
    const actualSha = actual[path] || "missing";
    if (actualSha !== expectedSha) diff.push({ path, expected_sha: expectedSha, actual_sha: actualSha });
  }
  return diff;
}

export async function fetchTrustedManifest(commit, controlUrl = process.env.SPINNY_CONTROL_URL || "https://www.spinny.au") {
  const base = String(process.env.SPINNY_RELEASE_MANIFEST_BASE_URL || controlUrl || "https://www.spinny.au").replace(/\/$/, "");
  const url = process.env.SPINNY_RELEASE_MANIFEST_URL || `${base}/api/spinny/releases/${commit}/manifest`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
  const manifest = await res.json();
  if (manifest.commit && manifest.commit !== commit) throw new Error("manifest commit mismatch");
  if (!verifyManifestSignature(manifest)) throw new Error("manifest signature verification failed");
  return manifest;
}

export async function verifyWorkingTree(repoRoot = process.cwd(), commit = currentCommit(repoRoot)) {
  const manifest = await fetchTrustedManifest(commit);
  const diff = compareManifest(repoRoot, manifest);
  if (diff.length) {
    const err = new Error("working tree does not match signed release manifest");
    err.diff = diff;
    throw err;
  }
  verifyPackageLock(repoRoot);
  return manifest;
}

export async function verifyGitCommit(repoRoot, commit) {
  const manifest = await fetchTrustedManifest(commit);
  for (const [path, expectedSha] of Object.entries(manifest.files || {})) {
    let blob;
    try {
      blob = execFileSync("git", ["show", `${commit}:${path}`], { cwd: repoRoot });
    } catch {
      throw new Error(`signed release missing file ${path}`);
    }
    const actualSha = createHash("sha256").update(blob).digest("hex");
    if (actualSha !== expectedSha) throw new Error(`signed release hash mismatch for ${path}`);
  }
  verifyPackageLockAtCommit(repoRoot, commit);
  return manifest;
}

export function cacheVerifiedRelease(repoRoot, manifest) {
  if (!verifyManifestSignature(manifest)) throw new Error("cannot cache unsigned release");
  const commit = manifest.commit || currentCommit(repoRoot);
  const root = join(releasesPath(), commit);
  const filesDir = join(root, "files");
  mkdirSync(filesDir, { recursive: true });
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  for (const path of Object.keys(manifest.files || {})) {
    const src = join(repoRoot, path);
    if (!existsSync(src)) continue;
    const dst = join(filesDir, path);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  writeFileSync(join(root, "verified_at"), `${new Date().toISOString()}\n`, "utf8");
  pruneReleaseCache();
  return root;
}

export function cachedReleases() {
  if (!existsSync(releasesPath())) return [];
  return readdirSync(releasesPath(), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const root = join(releasesPath(), entry.name);
      let verifiedAt = "";
      try { verifiedAt = readFileSync(join(root, "verified_at"), "utf8").trim(); } catch {}
      return { commit: entry.name, path: root, verified_at: verifiedAt };
    })
    .sort((a, b) => String(b.verified_at).localeCompare(String(a.verified_at)));
}

function pruneReleaseCache(keep = 3) {
  // Intentionally conservative: pruning implementation is left to platform
  // installers so read-only cache ACLs are not loosened during incident response.
  return cachedReleases().slice(0, keep);
}

function verifyPackageLock(repoRoot) {
  const path = join(repoRoot, "package-lock.json");
  if (!existsSync(path)) return;
  const lock = JSON.parse(readFileSync(path, "utf8"));
  const missing = Object.entries(lock.packages || {}).filter(([name, meta]) => name && meta?.resolved && !meta?.integrity);
  if (missing.length) throw new Error(`package-lock has packages without integrity: ${missing.slice(0, 5).map(([name]) => name).join(", ")}`);
}

function verifyPackageLockAtCommit(repoRoot, commit) {
  let raw;
  try { raw = execFileSync("git", ["show", `${commit}:package-lock.json`], { cwd: repoRoot, encoding: "utf8" }); }
  catch { return; }
  const lock = JSON.parse(raw);
  const missing = Object.entries(lock.packages || {}).filter(([name, meta]) => name && meta?.resolved && !meta?.integrity);
  if (missing.length) throw new Error(`package-lock has packages without integrity: ${missing.slice(0, 5).map(([name]) => name).join(", ")}`);
}

function walkFiles(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const rel = relative(root, path).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (!EXCLUDED_PARTS.has(entry.name)) out.push(...walkFiles(path).map(child => join(entry.name, child).replaceAll("\\", "/")));
    } else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function excluded(path) {
  const parts = path.replaceAll("\\", "/").split("/");
  if (parts.some(part => EXCLUDED_PARTS.has(part))) return true;
  const name = parts.at(-1);
  if (EXCLUDED_NAMES.has(name)) return true;
  return EXCLUDED_SUFFIXES.some(suffix => path.endsWith(suffix));
}

