import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { quarantinePath } from "./paths.js";
import { deriveStorageKey, encryptJson } from "./storage-crypto.js";
import { ensureNodeIdentity } from "./identity.js";
import { appendSecurityEvent, chainTip } from "./security-log.js";
import { cachedReleases, compareManifest, verifyManifestSignature } from "./release-manifest.js";

const HEALABLE = [/^src\//, /^scripts\//, /^ui\/src\//, /^package\.json$/, /^package-lock\.json$/, /^install\.sh$/];
const NEVER = [/state\.json$/, /state\.enc$/, /^\.env$/, /vault\.sqlite$/, /security\.jsonl$/, /^releases\//, /^quarantine\//];

export function classifyHealTier(diff) {
  const paths = diff.map(item => item.path || "");
  if (paths.some(path => path === "install.sh")) return 3;
  if (paths.some(path => NEVER.some(re => re.test(path)))) return 4;
  if (paths.some(path => !isHealable(path))) return 3;
  return paths.length <= 3 ? 1 : 2;
}

export function captureForensicSnapshot(diff, { processFingerprint = {}, networkViolationsRecent = [] } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(quarantinePath(), stamp);
  const filesDir = join(dir, "files");
  mkdirSync(filesDir, { recursive: true });
  const identity = ensureNodeIdentity();
  const key = deriveStorageKey(identity.privateKey.export({ type: "pkcs8", format: "der" }), "spinny-quarantine-v1");
  const evidence = {
    detected_at: new Date().toISOString(),
    files_tampered: diff,
    process_fingerprint: processFingerprint,
    network_violations_recent: networkViolationsRecent,
    chain_tip_at_detection: chainTip().head || "",
  };
  writeFileSync(join(dir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o500 });
  for (const item of diff) {
    const path = item.path;
    if (!path || !existsSync(path)) continue;
    const sealed = encryptJson({ path, bytes_b64: readFileSync(path).toString("base64") }, key, "spinny-quarantine-file");
    writeFileSync(join(filesDir, `${path.replaceAll("/", "__")}.enc`), sealed, { encoding: "utf8", mode: 0o400 });
  }
  appendSecurityEvent("recovery.forensic_snapshot", { path: dir, file_count: diff.length });
  return dir;
}

export function healTier1(diff, repoRoot = process.cwd()) {
  if (classifyHealTier(diff) !== 1) throw new Error("tier1 only restores three or fewer healable files");
  const release = latestVerifiedRelease();
  const manifest = JSON.parse(readFileSync(join(release.path, "manifest.json"), "utf8"));
  if (!verifyManifestSignature(manifest)) throw new Error("cached release signature verification failed");
  for (const item of diff) {
    const rel = item.path;
    const src = join(release.path, "files", rel);
    if (!existsSync(src)) throw new Error(`cached release is missing ${rel}`);
    const dst = join(repoRoot, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  const event = { tier: 1, outcome: "success", files_restored: diff.length };
  appendSecurityEvent("recovery.event", event);
  return event;
}

export function cachedReleaseList() {
  return cachedReleases();
}

function latestVerifiedRelease() {
  for (const release of cachedReleases()) {
    try {
      const manifest = JSON.parse(readFileSync(join(release.path, "manifest.json"), "utf8"));
      if (verifyManifestSignature(manifest) && compareManifest(process.cwd(), manifest).length >= 0) return release;
    } catch {}
  }
  throw new Error("no verified cached release available");
}

function isHealable(path) {
  return HEALABLE.some(re => re.test(path)) && !NEVER.some(re => re.test(path));
}

