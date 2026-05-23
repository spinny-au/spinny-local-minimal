import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function spinnyHome() {
  const home = process.env.SPINNY_HOME || join(homedir(), ".spinny-local");
  mkdirSync(home, { recursive: true });
  return home;
}

export function statePath() {
  return join(spinnyHome(), "state.json");
}

export function stateEncPath() {
  return join(spinnyHome(), "state.enc");
}

export function securityLogPath() {
  return join(spinnyHome(), "security.jsonl");
}

export function releasesPath() {
  return join(spinnyHome(), "releases");
}

export function quarantinePath() {
  return join(spinnyHome(), "quarantine");
}

export function vaultPath() {
  return join(spinnyHome(), "vault.sqlite");
}

export function insecureKeyPath(name) {
  return join(spinnyHome(), `${name}.insecure`);
}
