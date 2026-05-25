import { spawn } from "node:child_process";
import { join } from "node:path";

const KEYGUARD_PORT = parseInt(process.env.KEYGUARD_PORT || "47822", 10);
const KEYGUARD_URL = `http://127.0.0.1:${KEYGUARD_PORT}`;

let _keyguardProcess = null;

// ── Spawn ──────────────────────────────────────────────────────────────────────

export function spawnKeyguard(repoRoot) {
  if (_keyguardProcess) return _keyguardProcess;

  const script = join(repoRoot || process.env.SPINNY_KEYGUARD_PATH || "", "src", "headless.js");

  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, KEYGUARD_PORT: String(KEYGUARD_PORT) },
    windowsHide: true,
  });

  child.stdout.once("data", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.ready) console.log(`[keyguard] ready on port ${msg.port} (pid ${msg.pid})`);
    } catch {}
  });

  child.stderr.on("data", (d) => {
    console.error(`[keyguard] ${d.toString().trim()}`);
  });

  child.on("exit", (code) => {
    console.log(`[keyguard] exited (code ${code})`);
    _keyguardProcess = null;
  });

  _keyguardProcess = child;
  return child;
}

// ── Health ─────────────────────────────────────────────────────────────────────

export async function keyguardHealth() {
  try {
    const r = await fetch(`${KEYGUARD_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

export async function waitForKeyguard(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await keyguardHealth();
    if (health?.ok) return health;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("KeyGuard did not become ready");
}

// ── API ────────────────────────────────────────────────────────────────────────

async function request(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(5000),
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${KEYGUARD_URL}${path}`, opts);
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `KeyGuard ${r.status}`);
  }
  return r.json();
}

export function listKeys() {
  return request("GET", "/keys");
}

export function getKey(name) {
  return request("GET", `/keys/${encodeURIComponent(name)}`);
}

export function setKey(name, value, metadata) {
  return request("POST", `/keys/${encodeURIComponent(name)}`, { value, metadata });
}

export function deleteKey(name) {
  return request("DELETE", `/keys/${encodeURIComponent(name)}`);
}
