#!/usr/bin/env node
import { cacheVerifiedRelease, verifyGitCommit, verifyWorkingTree } from "./release-manifest.js";

const command = process.argv[2] || "verify-current";
const repoRoot = process.argv[3] || process.cwd();
const target = process.argv[4] || "";

try {
  if (command === "verify-current") {
    const manifest = await verifyWorkingTree(repoRoot);
    cacheVerifiedRelease(repoRoot, manifest);
    console.log("signed release verified");
  } else if (command === "verify-commit") {
    if (!target) throw new Error("verify-commit requires a commit");
    const manifest = await verifyGitCommit(repoRoot, target);
    console.log(`signed release commit verified: ${manifest.commit || target}`);
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} catch (err) {
  console.error(`security verification failed: ${err.message}`);
  process.exitCode = 2;
}
