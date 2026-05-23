import { appendSecurityEvent } from "./security-log.js";

const DEFAULT_ALLOWED = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "www.spinny.au",
  "spinny.au",
  "spinny-local-relay.spinny-au.workers.dev",
  "relay.spinny.au",
  "ollama.com",
  "api.telegram.org",
  "github.com",
  "raw.githubusercontent.com",
  "api.github.com",
]);

let installed = false;
let originalFetch = globalThis.fetch;

export class NetworkViolation extends Error {}

export function allowedHosts() {
  const hosts = new Set(DEFAULT_ALLOWED);
  for (const raw of String(process.env.SPINNY_EGRESS_ALLOWLIST || "").split(/[;,]/)) {
    const host = raw.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  for (const rawUrl of [process.env.SPINNY_OLLAMA_URL, process.env.SPINNY_CONTROL_URL, process.env.SPINNY_RELAY_URL]) {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (host) hosts.add(host);
    } catch {}
  }
  return hosts;
}

export function assertAllowed(url) {
  const parsed = new URL(String(url));
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) throw new NetworkViolation(`blocked outbound protocol: ${parsed.protocol}`);
  const host = parsed.hostname.toLowerCase();
  const allowed = allowedHosts();
  const ok = allowed.has(host) || [...allowed].some(pattern => pattern.startsWith("*.") && host.endsWith(pattern.slice(1)));
  if (!ok) {
    appendSecurityEvent("network.violation", { scheme: parsed.protocol.replace(":", ""), url_host: host });
    throw new NetworkViolation(`blocked outbound host: ${host}`);
  }
}

export async function secureFetch(url, init) {
  if (process.env.SPINNY_EGRESS_ENFORCE !== "0") assertAllowed(url);
  return originalFetch(url, init);
}

export function installSecureFetch() {
  if (installed || !globalThis.fetch) return;
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = secureFetch;
  installed = true;
}
