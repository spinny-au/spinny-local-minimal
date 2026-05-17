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

export function vaultPath() {
  return join(spinnyHome(), "vault.sqlite");
}

export function insecureKeyPath(name) {
  return join(spinnyHome(), `${name}.insecure`);
}
