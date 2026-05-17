import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { insecureKeyPath } from "./paths.js";

const SERVICE = "spinny-local-minimal";

export class SecureStoreUnavailable extends Error {}

export function readSecret(name) {
  try {
    if (platform() === "win32") return readWindowsSecret(name);
    if (platform() === "darwin") return readMacSecret(name);
    return readLinuxSecret(name);
  } catch (error) {
    if (isMissingSecret(error)) return null;
    return readInsecureFallback(name, error);
  }
}

export function writeSecret(name, value) {
  try {
    if (platform() === "win32") return writeWindowsSecret(name, value);
    if (platform() === "darwin") return writeMacSecret(name, value);
    return writeLinuxSecret(name, value);
  } catch (error) {
    return writeInsecureFallback(name, value, error);
  }
}

function readWindowsSecret(name) {
  const script = [
    `$path = Join-Path $env:APPDATA '${SERVICE}\\${name}.dpapi'`,
    "if (!(Test-Path $path)) { exit 2 }",
    "$secure = Get-Content -LiteralPath $path | ConvertTo-SecureString",
    "$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }"
  ].join("; ");
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
}

function writeWindowsSecret(name, value) {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const script = [
    `$dir = Join-Path $env:APPDATA '${SERVICE}'`,
    "New-Item -ItemType Directory -Force $dir | Out-Null",
    `$plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    "$secure = ConvertTo-SecureString $plain -AsPlainText -Force",
    `$secure | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $dir '${name}.dpapi')`
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
}

function readMacSecret(name) {
  return execFileSync("security", ["find-generic-password", "-a", name, "-s", SERVICE, "-w"], {
    encoding: "utf8"
  }).trim();
}

function writeMacSecret(name, value) {
  execFileSync("security", ["add-generic-password", "-U", "-a", name, "-s", SERVICE, "-w", value], {
    stdio: "ignore"
  });
}

function readLinuxSecret(name) {
  return execFileSync("secret-tool", ["lookup", "service", SERVICE, "name", name], {
    encoding: "utf8"
  }).trim();
}

function writeLinuxSecret(name, value) {
  execFileSync("secret-tool", ["store", "--label", `${SERVICE}:${name}`, "service", SERVICE, "name", name], {
    input: value,
    stdio: ["pipe", "ignore", "ignore"]
  });
}

function readInsecureFallback(name, cause) {
  if (process.env.SPINNY_ALLOW_INSECURE_FILE_KEY !== "1") {
    throw new SecureStoreUnavailable(
      `OS secure storage is unavailable for ${name}. Set SPINNY_ALLOW_INSECURE_FILE_KEY=1 only for development.`,
      { cause }
    );
  }
  const path = insecureKeyPath(name);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").trim();
}

function writeInsecureFallback(name, value, cause) {
  if (process.env.SPINNY_ALLOW_INSECURE_FILE_KEY !== "1") {
    throw new SecureStoreUnavailable(
      `OS secure storage is unavailable for ${name}. Set SPINNY_ALLOW_INSECURE_FILE_KEY=1 only for development.`,
      { cause }
    );
  }
  writeFileSync(insecureKeyPath(name), `${value}\n`, { encoding: "utf8", mode: 0o600 });
}

function isMissingSecret(error) {
  if (platform() === "win32") return error.status === 2;
  if (platform() === "darwin") return error.status === 44;
  return error.status === 1;
}
