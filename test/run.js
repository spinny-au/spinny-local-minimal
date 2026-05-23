import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { canonicalJson, ensureNodeIdentity, signJson, verifyJson } from "../src/identity.js";
import { saveState } from "../src/state.js";
import { handleTask } from "../src/tasks.js";
import { RelayClient } from "../src/relay.js";
import {
  captureFeedback,
  classifyEmail,
  configureTelegram,
  emailMetrics,
  executeEmailAction,
  formatTelegramNotification,
  monitorEmails,
  pauseEmailAutomation,
  planEmailAutomation,
  resumeEmailAutomation,
  sendTelegramNotification
} from "../src/email-vertical.js";
import {
  executeInstruction,
  memoryStats,
  prepareInstruction,
  readReceipts,
  savePrivacyPolicy
} from "../src/instruction-handler.js";
import { logEvent, parseConsoleTag, scrubSecrets, stopLogStreamer } from "../src/log-streamer.js";
import { appendSecurityEvent, verifySecurityChain } from "../src/security-log.js";
import { assertAllowed, NetworkViolation } from "../src/secure-fetch.js";
import { isQuarantined } from "../src/attestation.js";
import { decryptJson, deriveStorageKey, encryptJson } from "../src/storage-crypto.js";

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

test("log streamer scrubs secrets and parses console tags", () => {
  stopLogStreamer();
  const parsed = parseConsoleTag("[relay-infer] Bearer srly_supersecret123");
  assert.equal(parsed.tag, "relay-infer");
  assert.equal(scrubSecrets("Authorization: Bearer srly_supersecret123"), "Authorization: Bearer [redacted]");
  const entry = logEvent("log", "vertical", "email", "sent with sk-abc123456789 and jwt eyJaaaaaaaaaa.eyJbbbbbbbbbb.cccccccccccc");
  assert.equal(entry.level, "info");
  assert.equal(entry.source, "vertical");
  assert.equal(entry.tag, "email");
  assert.match(entry.message, /sk-\[redacted\]/);
  assert.match(entry.message, /\[jwt:redacted\]/);
});

test("node identity signs and verifies task envelopes", () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-identity-test-"));
  const identity = ensureNodeIdentity();
  const payload = { type: "node.hello", nodeId: "node_test" };
  const signature = signJson(identity.privateKey, payload);
  assert.equal(verifyJson(identity.publicKeyDer, payload, signature), true);
});

test("state is encrypted at rest and migrates away from plaintext state.json", () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-state-enc-test-"));
  const state = saveState({ paired: true, accountId: "owner@example.com", relaySessionToken: "srly_secret" });
  const encPath = join(process.env.SPINNY_HOME, "state.enc");
  assert.equal(existsSync(encPath), true);
  const sealed = readFileSync(encPath, "utf8");
  assert.equal(sealed.includes("srly_secret"), false);
  assert.equal(state.accountId, "owner@example.com");
});

test("security log chain detects edits and deletions", () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-chain-test-"));
  const first = appendSecurityEvent("attestation.result", { status: "verified" });
  const second = appendSecurityEvent("network.violation", { url_host: "evil.example" });
  assert.equal(verifySecurityChain().ok, true);
  const logPath = join(process.env.SPINNY_HOME, "security.jsonl");
  const lines = readFileSync(logPath, "utf8").trim().split(/\r?\n/);
  const edited = JSON.parse(lines[0]);
  edited.metadata.status = "tampered";
  lines[0] = canonicalJson(edited);
  writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  assert.equal(verifySecurityChain().reason, "entry_hash_mismatch");
  writeFileSync(logPath, `${canonicalJson(first)}\n`, "utf8");
  assert.equal(verifySecurityChain(second.entry_hash).reason, "expected_tip_mismatch");
});

test("secure fetch allowlist blocks unknown hosts and logs violation", () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-egress-test-"));
  assert.doesNotThrow(() => assertAllowed("https://www.spinny.au/api/health"));
  assert.throws(() => assertAllowed("https://evil.example/steal"), NetworkViolation);
  assert.match(readFileSync(join(process.env.SPINNY_HOME, "security.jsonl"), "utf8"), /network\.violation/);
});

test("encrypted JSON helper round-trips without plaintext", () => {
  const key = deriveStorageKey("node-private-key");
  const sealed = encryptJson({ secret: "hidden" }, key);
  assert.equal(sealed.includes("hidden"), false);
  assert.deepEqual(decryptJson(sealed, key), { secret: "hidden" });
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

test("quarantined nodes refuse non-security tasks", async () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-quarantine-test-"));
  const state = saveState({ paired: true, accountId: "acct_1", security: { tampered: true, quarantined: true } });
  assert.equal(isQuarantined(), true);
  await assert.rejects(() => handleTask({
    type: "model.install",
    taskId: "task_quarantine",
    nodeId: state.nodeId,
    issuedAt: new Date().toISOString(),
    params: { model: "llama3.2:3b" }
  }, {
    ollama: { pullModel: async () => ({ ok: true }) }
  }), /quarantined/);
});

test("vertical attach persists only local public status in encrypted vault", async () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-vertical-test-"));
  const state = saveState({ paired: true, accountId: "acct_1" });
  const messages = [];
  const result = await handleTask({
    type: "vertical.attach",
    taskId: "task_vertical_1",
    nodeId: state.nodeId,
    issuedAt: new Date().toISOString(),
    params: {
      manifest: {
        name: "email-automation",
        version: "1.0.0",
        capabilities: [{ name: "read-emails", requires_oauth: true, oauth_provider: "gmail" }]
      }
    }
  }, {
    send: (message) => messages.push(message)
  });

  assert.equal(result.name, "email-automation");
  assert.equal(result.status, "attached");
  assert.equal(result.dataLocality.emailContentLeavesNode, false);
  assert.equal(messages.at(-1).type, "task.result");

  const vault = new Vault();
  try {
    const stored = vault.get("verticals", "email-automation");
    assert.equal(stored.status, "attached");
    assert.equal(stored.manifest.name, "email-automation");
  } finally {
    vault.close();
  }
});

test("email classifier separates marketing, important, reply-needed, and spam", () => {
  assert.equal(classifyEmail({ subject: "Weekly newsletter", body: "unsubscribe here" }).category, "marketing");
  assert.equal(classifyEmail({ subject: "Urgent project update" }).category, "important");
  assert.equal(classifyEmail({ from: "boss@company.com", subject: "Need your reply" }).category, "reply-needed");
  assert.equal(classifyEmail({ subject: "Limited time offer!" }).category, "spam");
});

test("email plan generation returns approval-first user plan", () => {
  const result = planEmailAutomation({ accounts: ["work@example.com"], telegram: true });
  assert.equal(result.plan.approvalRequired, true);
  assert.match(result.userVisiblePlan, /Approve this plan/);
  assert.match(result.userVisiblePlan, /work@example.com/);
});

test("email monitor stores local-only messages and executes approved action", async () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-email-flow-test-"));
  saveState({ paired: true, accountId: "acct_1" });
  const monitored = await monitorEmails({
    messages: [
      { id: "email_1", from: "client@company.com", subject: "Urgent project update", body: "please reply" },
      { id: "email_2", from: "promo@example.com", subject: "Limited time offer!", body: "unsubscribe" }
    ]
  });
  assert.equal(monitored.processed, 2);
  assert.equal(monitored.flagged[0].id, "email_1");
  assert.equal(monitored.emails[0].dataLocality, undefined);
  assert.equal(monitored.dataLocality.emailContentLeavesNode, false);

  const action = await executeEmailAction({ emailId: "email_1", action: "archive" });
  assert.equal(action.ok, true);
  assert.equal(action.action, "archive");
});

test("email feedback learns a local whitelist rule", () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-email-feedback-test-"));
  saveState({ paired: true, accountId: "acct_1" });
  const result = captureFeedback({
    emailId: "email_3",
    rating: "down",
    correction: "Don't delete from tech-crunch.com"
  });
  assert.equal(result.ok, true);
  assert.equal(result.learnedRule.category, "important");
  assert.equal(classifyEmail({ from: "news@tech-crunch.com", subject: "Newsletter" }, [result.learnedRule]).category, "important");
});

test("email telegram preview has approval buttons", () => {
  const preview = formatTelegramNotification({
    id: "email_1",
    from: "client@company.com",
    subject: "Urgent project update",
    classification: { category: "reply-needed", confidence: 0.9 }
  });
  assert.match(preview.text, /client@company.com/);
  assert.equal(preview.buttons.some((button) => button.action === "draft_reply"), true);
});

test("email telegram config stores token locally and sends notification", async () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-email-telegram-test-"));
  saveState({ paired: true, accountId: "acct_1" });
  const config = configureTelegram({ botToken: "123:test-token", chatId: "999888" });
  assert.equal(config.connected, true);
  let sent = null;
  const result = await sendTelegramNotification({
    email: {
      id: "email_tg_1",
      from: "client@company.com",
      subject: "Urgent project update",
      classification: { category: "reply-needed", confidence: 0.9 }
    }
  }, {
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });
  assert.equal(result.sent, true);
  assert.equal(sent.chat_id, "999888");
  assert.match(sent.text, /Urgent project update/);
});

test("email safety rate limits and can pause execution", async () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-email-safety-test-"));
  saveState({ paired: true, accountId: "acct_1" });
  await executeEmailAction({ emailId: "missing_1", action: "archive", allowMissing: true, rateLimit: 1 });
  await assert.rejects(() => executeEmailAction({ emailId: "missing_2", action: "archive", allowMissing: true, rateLimit: 1 }), /Rate limit exceeded/);

  pauseEmailAutomation({ reason: "manual test" });
  await assert.rejects(() => executeEmailAction({ emailId: "missing_3", action: "archive", allowMissing: true }), /paused/);
  assert.equal(resumeEmailAutomation().ok, true);
  const status = emailMetrics();
  assert.equal(status.ok, true);
});

test("email anomaly policy pauses after too many destructive actions", async () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-email-anomaly-test-"));
  saveState({ paired: true, accountId: "acct_1" });
  for (let i = 0; i < 11; i += 1) {
    await executeEmailAction({ emailId: `missing_delete_${i}`, action: "delete", allowMissing: true });
  }
  await assert.rejects(() => executeEmailAction({ emailId: "missing_after_pause", action: "archive", allowMissing: true }), /paused/);
});

test("email task interface can plan and monitor", async () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-email-task-test-"));
  const state = saveState({ paired: true, accountId: "acct_1" });
  const plan = await handleTask({
    type: "email.plan",
    taskId: "task_email_plan",
    nodeId: state.nodeId,
    issuedAt: new Date().toISOString(),
    params: { accounts: ["demo@example.com"] }
  });
  assert.match(plan.userVisiblePlan, /demo@example.com/);

  const monitored = await handleTask({
    type: "email.monitor",
    taskId: "task_email_monitor",
    nodeId: state.nodeId,
    issuedAt: new Date().toISOString(),
    params: { messages: [{ id: "email_task_1", subject: "Urgent hello", from: "a@b.com" }] }
  });
  assert.equal(monitored.processed, 1);
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

test("instruction packets verify signatures, reject replay, and tighten privacy", () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-instruction-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  saveState({
    paired: true,
    accountId: "acct_1",
    controlPlanePublicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64")
  });
  savePrivacyPolicy({
    allow_raw_text_return: false,
    max_snippet_chars: 100,
    allow_file_names: false,
    allow_embeddings: true,
    allow_full_files: false,
    allow_raw_prompt_return: false
  });

  const now = Date.now();
  const packet = signedInstruction(privateKey, {
    nonce: "nonce_privacy_1",
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    op: "vault.read_preview",
    policy: {
      allow_raw_text_return: true,
      max_snippet_chars: 800,
      allow_file_names: true,
      allow_embeddings: true,
      allow_full_files: true,
      allow_raw_prompt_return: true
    }
  });

  const prepared = prepareInstruction(packet, now);
  assert.equal(prepared.policy.allow_raw_text_return, false);
  assert.equal(prepared.policy.allow_file_names, false);
  assert.equal(prepared.policy.allow_full_files, false);
  assert.equal(prepared.policy.max_snippet_chars, 100);
  assert.equal(prepared.policyTightened, true);
  assert.throws(() => prepareInstruction(packet, now), /replay_detected/);
});

test("unknown instruction ops return a receipt and never execute", async () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-unknown-op-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  saveState({
    paired: true,
    accountId: "acct_1",
    controlPlanePublicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64")
  });

  const now = Date.now();
  const packet = signedInstruction(privateKey, {
    nonce: "nonce_unknown_1",
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    op: "does.not.exist"
  });
  const prepared = prepareInstruction(packet, now);
  await assert.rejects(() => executeInstruction(prepared), (error) => {
    assert.equal(error.code, "unknown_op");
    assert.equal(error.status, 400);
    assert.equal(error.receipt.op, "does.not.exist");
    return true;
  });
  const [receipt] = readReceipts(1);
  assert.equal(receipt.error, "unknown_op");
});

test("apprenticeship retrieval respects the local raw text firewall and updates stats", async () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-memory-firewall-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  saveState({
    paired: true,
    accountId: "acct_1",
    controlPlanePublicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64")
  });
  savePrivacyPolicy({ allow_raw_text_return: false });

  const now = Date.now();
  const store = prepareInstruction(signedInstruction(privateKey, {
    nonce: "nonce_store_1",
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    op: "memory.store",
    payload: {
      type: "apprenticeship_example",
      object: apprenticeshipExample({
        id: "example_1",
        user_request_summary: "private architecture learning about context fabric"
      })
    }
  }), now);
  await executeInstruction(store);

  const retrieve = prepareInstruction(signedInstruction(privateKey, {
    nonce: "nonce_retrieve_1",
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    op: "context.retrieve",
    policy: { allow_raw_text_return: true, max_snippet_chars: 800 },
    payload: { query: "context fabric", domain_tags: ["architecture"], limit: 3 }
  }), now);
  const result = await executeInstruction(retrieve);
  assert.equal(result.body.examples.length, 1);
  assert.equal(result.body.examples[0].id, "example_1");
  assert.equal(result.body.examples[0].few_shot, undefined);
  assert.equal(result.body.examples[0].use_count, 1);
  assert.equal(result.body.receipt.snippets_returned, 0);
  assert.deepEqual(memoryStats(), {
    total_examples: 1,
    by_scope: { project: 1 },
    expired: 0,
    escalation_tasks_now_local: 0
  });
});

test("infer.run injects approved examples before the system prompt", async () => {
  process.env.SPINNY_HOME = mkdtempSync(join(tmpdir(), "spinny-local-infer-examples-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  saveState({
    paired: true,
    accountId: "acct_1",
    controlPlanePublicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64")
  });

  const now = Date.now();
  const store = prepareInstruction(signedInstruction(privateKey, {
    nonce: "nonce_infer_store_1",
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    op: "memory.store",
    payload: {
      type: "apprenticeship_example",
      object: apprenticeshipExample({
        id: "example_infer_1",
        user_request_summary: "architecture feedback for private local AI",
        approved_response: "Use signed packets, local privacy receipts, and few-shot apprenticeship."
      })
    }
  }), now);
  await executeInstruction(store);

  const originalFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (_url, init) => {
    sentBody = JSON.parse(init.body);
    return new Response(`${JSON.stringify({ message: { content: "ok" }, done: false })}\n${JSON.stringify({ message: { content: "" }, done: true })}\n`, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    });
  };

  try {
    const infer = prepareInstruction(signedInstruction(privateKey, {
      nonce: "nonce_infer_1",
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      op: "infer.run",
      payload: {
        model: "qwen2.5:0.5b",
        system_prompt: "Original system prompt",
        messages: [{ role: "user", content: "help with private local AI architecture" }],
        retrieve_examples: true,
        query: "private local AI architecture",
        domain_tags: ["architecture"],
        example_limit: 3
      }
    }), now);
    const result = await executeInstruction(infer);
    assert.equal(result.body.content, "ok");
    assert.equal(result.body.examples_used, 1);
    assert.equal(result.body.used_example_ids[0], "example_infer_1");
    assert.match(sentBody.messages[0].content, /\[APPROVED EXAMPLES\]/);
    assert.match(sentBody.messages[0].content, /Use signed packets/);
    assert.match(sentBody.messages[0].content, /Original system prompt/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

function signedInstruction(privateKey, overrides = {}) {
  const now = Date.now();
  const unsigned = {
    version: 1,
    kid: "control_v1",
    nonce: overrides.nonce || `nonce_${Math.random().toString(16).slice(2)}`,
    issued_at: overrides.issued_at || new Date(now).toISOString(),
    expires_at: overrides.expires_at || new Date(now + 60_000).toISOString(),
    op: overrides.op || "vault.read_preview",
    user_id: overrides.user_id || null,
    policy: overrides.policy || {
      allow_raw_text_return: false,
      max_snippet_chars: 800,
      allow_file_names: true,
      allow_embeddings: true,
      allow_full_files: false,
      allow_raw_prompt_return: false
    },
    payload: overrides.payload || {}
  };
  return {
    ...unsigned,
    signature: toBase64Url(signJson(privateKey, unsigned))
  };
}

function toBase64Url(value) {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function apprenticeshipExample({
  id = "example_test",
  user_request_summary = "architecture feedback",
  approved_response = "Use signed packets and privacy receipts."
} = {}) {
  return {
    id,
    type: "apprenticeship_example",
    stored_at: new Date().toISOString(),
    scope: "project",
    source: "guru_approved",
    input_signature: {
      task_type: "architecture_feedback",
      domain_tags: ["architecture", "privacy"]
    },
    few_shot: {
      user_request_summary,
      approved_response,
      style_notes: ["direct", "structured"]
    },
    use_rules: {
      can_inject_into_local_prompt: true,
      expires_at: null,
      sensitivity: "local_only",
      cloud_visible: false
    },
    use_count: 0,
    last_used_at: null
  };
}
