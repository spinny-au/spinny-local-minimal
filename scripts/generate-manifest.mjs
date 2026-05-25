#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(join(import.meta.dirname, ".."));

const SKIP_PATTERNS = [
  /^node_modules\//, /^\.git\//, /^MANIFEST\.json$/,
  /^spinny-home\//, /^spinny-update-state\.json$/,
  /^\.update-signal$/, /^\.spinny-selfcoder\//,
  /^ui\/node_modules\//,
  /__pycache__/, /\.pyc$/,
];

function shouldSkip(relPath) {
  return SKIP_PATTERNS.some((p) => p.test(relPath));
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function walkFiles(dir, baseDir = dir) {
  const results = [];
  if (!existsSync(dir)) return results;
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

function getCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO_ROOT, windowsHide: true }).toString().trim();
  } catch {
    return null;
  }
}

const files = walkFiles(REPO_ROOT);
const manifestFiles = {};
for (const { path, full } of files) {
  try {
    manifestFiles[path] = sha256(readFileSync(full));
  } catch {
    manifestFiles[path] = null;
  }
}

const manifest = {
  commit: getCommit(),
  generatedAt: new Date().toISOString(),
  totalFiles: Object.keys(manifestFiles).length,
  files: manifestFiles,
};

const outPath = join(REPO_ROOT, "MANIFEST.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`MANIFEST.json written — ${manifest.totalFiles} files, commit ${(manifest.commit || "").slice(0, 8)}`);
