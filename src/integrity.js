import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ensureNodeIdentity, signJson } from "./identity.js";
import { loadState } from "./state.js";

const REPO_ROOT = join(import.meta.dirname, "..");

// Files/patterns to skip during integrity check
const SKIP_PATTERNS = [
  /^node_modules\//, /^\.git\//, /^MANIFEST\.json$/,
  /^spinny-home\//, /^spinny-update-state\.json$/,
  /^\.update-signal$/, /^\.spinny-selfcoder\//,
  /^ui\/node_modules\//, /^test\//,
  /__pycache__/, /\.pyc$/,
];

function shouldSkip(relPath) {
  return SKIP_PATTERNS.some((p) => p.test(relPath));
}

// ── Hash computation ────────────────────────────────────────────────────────────

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function walkFiles(dir, baseDir = dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(baseDir, full).replace(/\\/g, "/");
    if (shouldSkip(rel)) continue;
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, baseDir));
    } else if (entry.isFile()) {
      results.push({ path: rel, full });
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function computeFileHashes(repoRoot = REPO_ROOT) {
  const files = walkFiles(repoRoot);
  const hashes = {};
  for (const { path, full } of files) {
    try {
      const content = readFileSync(full);
      hashes[path] = sha256(content);
    } catch {
      hashes[path] = null; // unreadable file
    }
  }
  return { files: hashes, scannedAt: new Date().toISOString(), totalFiles: Object.keys(hashes).length };
}

// ── Manifest ────────────────────────────────────────────────────────────────────

function loadManifest(repoRoot = REPO_ROOT) {
  const manifestPath = join(repoRoot, "MANIFEST.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

// ── Diff ────────────────────────────────────────────────────────────────────────

function diffHashes(expected, actual) {
  const diffs = [];
  const allFiles = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const path of allFiles) {
    const expHash = expected[path];
    const actHash = actual[path];
    if (expHash == null) {
      diffs.push({ path, reason: "new_file", actual_sha: actHash });
    } else if (actHash == null) {
      diffs.push({ path, reason: "missing", expected_sha: expHash });
    } else if (expHash !== actHash) {
      diffs.push({ path, reason: "modified", expected_sha: expHash, actual_sha: actHash });
    }
  }
  return diffs;
}

// ── Attestation ─────────────────────────────────────────────────────────────────

export function runIntegrityCheck(repoRoot = REPO_ROOT) {
  const manifest = loadManifest(repoRoot);
  const actual = computeFileHashes(repoRoot);

  const diffs = manifest?.files
    ? diffHashes(manifest.files, actual.files)
    : [];

  const status = !manifest
    ? "no_manifest"
    : diffs.length > 0
      ? "tampered"
      : "verified";

  const state = loadState();
  const identity = ensureNodeIdentity();

  const payload = {
    nodeId: state.nodeId,
    type: "attestation.integrity",
    status,
    commit: manifest?.commit || null,
    manifest_hash: manifest ? sha256(JSON.stringify(manifest)) : null,
    diff: diffs.map((d) => ({
      path: d.path,
      ...(d.expected_sha ? { expected: d.expected_sha.slice(0, 12) } : {}),
      ...(d.actual_sha ? { actual: d.actual_sha.slice(0, 12) } : {}),
      reason: d.reason,
    })),
    totalFiles: actual.totalFiles,
    tampered: status === "tampered",
    timestamp: new Date().toISOString(),
    nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };

  const signature = signJson(identity.privateKey, payload);

  return {
    ok: true,
    status,
    diffs,
    totalFiles: actual.totalFiles,
    signed: { payload, signature },
  };
}

// ── Send to portal ──────────────────────────────────────────────────────────────

export async function sendAttestation(checkResult, controlUrl = null) {
  const state = loadState();
  const url = controlUrl || state.controlUrl || process.env.SPINNY_CONTROL_URL || "https://spinny.au";
  const { payload, signature } = checkResult.signed;

  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/api/spinny/local-nodes/${encodeURIComponent(state.nodeId)}/attestation`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload, signature }),
        signal: AbortSignal.timeout(10000),
      }
    );
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function attestAndSend() {
  const result = runIntegrityCheck();
  const sent = await sendAttestation(result);
  return { ...result, sent };
}
