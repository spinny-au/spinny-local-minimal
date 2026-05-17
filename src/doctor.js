import { ensureNodeIdentity } from "./identity.js";
import { OllamaClient } from "./ollama.js";
import { loadState } from "./state.js";
import { ensureVaultKey, Vault } from "./vault.js";

export async function runDoctor() {
  const checks = [];

  checks.push(await check("node identity", () => Boolean(ensureNodeIdentity().publicKeyDer)));
  checks.push(await check("vault key", () => ensureVaultKey().length === 32));
  checks.push(await check("sqlite vault", () => {
    const vault = new Vault();
    vault.close();
    return true;
  }));

  const state = loadState();
  checks.push({
    name: "pairing",
    ok: state.paired,
    detail: state.paired ? `paired as ${state.nodeId}` : "not paired yet"
  });

  const ollama = await new OllamaClient().health();
  checks.push({
    name: "ollama",
    ok: ollama.ok,
    detail: ollama.ok ? `reachable (${ollama.status})` : (ollama.error || `status ${ollama.status}`)
  });

  return checks;
}

async function check(name, fn) {
  try {
    const result = await fn();
    return { name, ok: Boolean(result), detail: Boolean(result) ? "ok" : "failed" };
  } catch (error) {
    return { name, ok: false, detail: error.message };
  }
}
