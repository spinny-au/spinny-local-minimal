import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";
import { spawn, execSync } from "node:child_process";

// ── Safety ──────────────────────────────────────────────────────────────────────

function assertInside(repoRoot, targetPath) {
  const root = resolve(repoRoot);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(`Path escapes repo root: ${target}`);
  }
  return target;
}

// ── Filesystem ──────────────────────────────────────────────────────────────────

export function readFile(repoRoot, filePath) {
  const full = join(resolve(repoRoot), filePath);
  assertInside(repoRoot, full);
  if (!existsSync(full)) throw new Error(`File not found: ${filePath}`);
  return { path: filePath, content: readFileSync(full, "utf8") };
}

export function writeFile(repoRoot, filePath, content) {
  const full = join(resolve(repoRoot), filePath);
  assertInside(repoRoot, full);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, String(content), "utf8");
  return { path: filePath, written: true };
}

export function patchFile(repoRoot, filePath, oldStr, newStr) {
  const { content } = readFile(repoRoot, filePath);
  if (!content.includes(oldStr)) throw new Error("old_str not found in file");
  const updated = content.replace(oldStr, newStr);
  const count = content.split(oldStr).length - 1;
  writeFileSync(join(resolve(repoRoot), filePath), updated, "utf8");
  return { path: filePath, replaced: count };
}

export function listDir(repoRoot, dirPath = ".") {
  const full = resolve(repoRoot, dirPath);
  assertInside(repoRoot, full);
  if (!existsSync(full)) throw new Error(`Directory not found: ${dirPath}`);
  const entries = readdirSync(full, { withFileTypes: true });
  return entries.map((e) => ({
    name: e.name,
    type: e.isDirectory() ? "dir" : "file",
    size: e.isFile() ? statSync(join(full, e.name)).size : 0,
  }));
}

// ── Git ─────────────────────────────────────────────────────────────────────────

function git(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.on("error", (err) => resolve({ code: 1, stdout: "", stderr: err.message }));
  });
}

export async function gitStatus(repoRoot) {
  const r = resolve(repoRoot);
  const current = await git(r, ["branch", "--show-current"]);
  const status = await git(r, ["status", "--short"]);
  const log = await git(r, ["log", "--oneline", "-5"]);
  return {
    branch: current.stdout || "unknown",
    dirty: status.stdout.split("\n").filter(Boolean),
    recent: log.stdout.split("\n").filter(Boolean),
  };
}

export async function gitBranch(repoRoot, name, base) {
  const r = resolve(repoRoot);
  const safe = String(name).replace(/[^a-zA-Z0-9/_-]/g, "-").slice(0, 96);
  if (!safe || safe === "main" || safe === "master") throw new Error("Cannot create branch named main/master");
  const args = base ? ["checkout", "-b", safe, base] : ["checkout", "-b", safe];
  const result = await git(r, args);
  if (result.code !== 0) throw new Error(`git branch failed: ${result.stderr}`);
  return { branch: safe, created: true };
}

export async function gitCommit(repoRoot, message) {
  const r = resolve(repoRoot);
  const add = await git(r, ["add", "-A"]);
  const commit = await git(r, ["commit", "-m", message]);
  if (commit.code !== 0 && !commit.stdout.includes("nothing to commit")) {
    throw new Error(`git commit failed: ${commit.stderr}`);
  }
  const log = await git(r, ["log", "--oneline", "-1"]);
  return { committed: commit.code === 0, hash: log.stdout };
}

export async function gitPush(repoRoot, branch) {
  const r = resolve(repoRoot);
  const result = await git(r, ["push", "origin", branch || "HEAD"]);
  if (result.code !== 0) throw new Error(`git push failed: ${result.stderr}`);
  return { pushed: true, output: result.stderr || result.stdout };
}

export async function gitClone(url, targetPath) {
  const r = resolve(targetPath);
  if (existsSync(r)) throw new Error(`Target path already exists: ${targetPath}`);
  mkdirSync(join(r, ".."), { recursive: true });
  const result = await git(join(r, ".."), ["clone", url, basename(r)]);
  if (result.code !== 0) throw new Error(`git clone failed: ${result.stderr}`);
  return { cloned: true, path: r };
}

export async function gitCreateRepo(name, description, isPrivate, token) {
  const r = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ name, description: description || "", private: isPrivate !== false, auto_init: false }),
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text().catch(() => "")}`);
  const data = await r.json();
  return { name: data.name, fullName: data.full_name, cloneUrl: data.clone_url, htmlUrl: data.html_url };
}

export async function gitCreatePR(repoRoot, title, base = "main") {
  const r = resolve(repoRoot);
  const remote = await git(r, ["remote", "get-url", "origin"]);
  if (remote.code !== 0) throw new Error("No origin remote");
  // Derive owner/repo from the remote URL
  const match = remote.stdout.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot parse remote: ${remote.stdout}`);
  const repo = match[2].replace(/\.git$/, "");
  // Use gh CLI for PR creation
  const pr = await git(r, ["-c", "push.default=current", "push", "-u", "origin", (await git(r, ["branch", "--show-current"])).stdout]);
  const token = process.env.GITHUB_TOKEN || process.env.SPINNY_GITHUB_TOKEN || "";
  if (token) {
    const apiRes = await fetch(`https://api.github.com/repos/${match[1]}/${repo}/pulls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ title, head: (await git(r, ["branch", "--show-current"])).stdout, base }),
    });
    if (apiRes.ok) {
      const prData = await apiRes.json();
      return { prUrl: prData.html_url, number: prData.number };
    }
  }
  return { pushed: true, note: "gh CLI or token needed for automated PR creation" };
}

// ── Build / Test ────────────────────────────────────────────────────────────────

export function runCommand(repoRoot, command, args = []) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: resolve(repoRoot), shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ ok: code === 0, code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.on("error", (err) => resolve({ ok: false, code: 1, stdout: "", stderr: err.message }));
  });
}

export function npmRun(repoRoot, script) {
  const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return runCommand(repoRoot, cmd, ["run", script]);
}

// ── Preview serving ─────────────────────────────────────────────────────────────

// Track active previews so we can tear them down
const activePreviews = new Map();

export function getPreviewUrl(taskId) {
  const entry = activePreviews.get(taskId);
  return entry ? entry.url : null;
}

export function registerPreview(taskId, distPath) {
  const url = `/preview/${taskId}`;
  activePreviews.set(taskId, { url, distPath, registeredAt: Date.now() });
  return url;
}

export function removePreview(taskId) {
  activePreviews.delete(taskId);
}

export function resolvePreviewDist(urlPath) {
  const match = urlPath.match(/^\/preview\/([^/]+)/);
  if (!match) return null;
  const entry = activePreviews.get(match[1]);
  return entry ? entry.distPath : null;
}
