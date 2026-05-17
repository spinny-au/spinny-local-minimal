import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { canonicalJson, ensureNodeIdentity, signJson, verifyJson } from "../src/identity.js";
import { saveState } from "../src/state.js";
import { handleTask } from "../src/tasks.js";
import { RelayClient } from "../src/relay.js";

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("vault encrypts and decrypts JSON values", () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-vault-test-"));
  const vault = new Vault();
  vault.put("memory", "hello", { value: "world" });
  assert.deepEqual(vault.get("memory", "hello"), { value: "world" });
  vault.close();
});

test("canonicalJson is stable for signature payloads", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
});

test("node identity signs and verifies task envelopes", () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-identity-test-"));
  const identity = ensureNodeIdentity();
  const payload = { type: "node.hello", nodeId: "node_test" };
  const signature = signJson(identity.privateKey, payload);
  assert.equal(verifyJson(identity.publicKeyDer, payload, signature), true);
});

test("model install is only handled for paired node addressed tasks", async () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-task-test-"));
  const state = saveState({ paired: true, accountId: "acct_1" });
  const messages = [];
  const result = await handleTask({
    type: "model.install",
    taskId: "task_1",
    nodeId: state.nodeId,
    issuedAt: new Date().toISOString(),
    params: { model: "llama3.2:3b" }
  }, {
    send: (message) => messages.push(message),
    ollama: {
      pullModel: async (model) => ({ ok: true, model })
    }
  });

  assert.deepEqual(result, { ok: true, model: "llama3.2:3b" });
  assert.equal(messages[0].type, "task.progress");
  assert.equal(messages.at(-1).type, "task.result");
});

test("rejects tasks addressed to a different node", async () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-reject-test-"));
  saveState({ paired: true, accountId: "acct_1" });
  await assert.rejects(() => handleTask({
    type: "model.install",
    taskId: "task_1",
    nodeId: "node_other",
    issuedAt: new Date().toISOString(),
    params: { model: "llama3.2:3b" }
  }, {
    ollama: {
      pullModel: async () => ({ ok: true })
    }
  }), /different node/);
});

test("relay rejects unsigned production task envelopes", () => {
  const relay = new RelayClient({ allowUnsignedTasks: false, reconnect: false });
  assert.throws(() => relay.verifyEnvelope({
    payload: {
      type: "model.install",
      taskId: "task_1",
      nodeId: "node_1",
      issuedAt: new Date().toISOString(),
      params: { model: "llama3.2:3b" }
    }
  }, "node_1"), /refusing unsigned task/);
});

test("relay allows unsigned development task envelopes only in dev mode", () => {
  const relay = new RelayClient({ allowUnsignedTasks: true, reconnect: false });
  const payload = relay.verifyEnvelope({
    payload: {
      type: "model.install",
      taskId: "task_1",
      nodeId: "node_1",
      issuedAt: new Date().toISOString(),
      params: { model: "llama3.2:3b" }
    }
  }, "node_1");
  assert.equal(payload.type, "model.install");
});

process.env.SPINNY_ALLOW_INSECURE_FILE_KEY = "1";

for (const entry of tests) {
  try {
    await entry.fn();
    console.log(`ok - ${entry.name}`);
  } catch (error) {
    console.error(`not ok - ${entry.name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
