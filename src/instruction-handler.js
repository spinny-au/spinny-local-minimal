import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { canonicalJson } from "./identity.js";
import { spinnyHome } from "./paths.js";
import { loadState } from "./state.js";
import { Vault } from "./vault.js";

const MAX_EXPIRY_WINDOW_MS = 5 * 60 * 1000;
const NONCE_RETENTION_MS = 10 * 60 * 1000;
const MAX_RECEIPTS = 1000;
const VAULT_NS = "byok";
const APPRENTICESHIP_TYPE = "apprenticeship_example";

const DEFAULT_PRIVACY_POLICY = {
  allow_raw_text_return: false,
  max_snippet_chars: 800,
  allow_file_names: true,
  allow_embeddings: true,
  allow_full_files: false,
  allow_raw_prompt_return: false
};

const BOOLEAN_POLICY_FIELDS = [
  "allow_raw_text_return",
  "allow_file_names",
  "allow_embeddings",
  "allow_full_files",
  "allow_raw_prompt_return"
];

const nonceStore = new Map();

export class InstructionError extends Error {
  constructor(code, status = 400, message = code, receipt = null) {
    super(message);
    this.name = "InstructionError";
    this.code = code;
    this.status = status;
    this.receipt = receipt;
  }
}

export function loadPrivacyPolicy() {
  const path = privacyPath();
  if (!existsSync(path)) {
    writeJsonFile(path, DEFAULT_PRIVACY_POLICY);
    return { ...DEFAULT_PRIVACY_POLICY };
  }
  try {
    return normalizePrivacyPolicy(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_PRIVACY_POLICY };
  }
}

export function savePrivacyPolicy(policy) {
  const next = normalizePrivacyPolicy(policy);
  writeJsonFile(privacyPath(), next);
  return next;
}

export function readReceipts(limit = 20) {
  const count = clampNumber(limit, 20, 1, MAX_RECEIPTS);
  const path = receiptsPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-count).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean).reverse();
}

export function prepareInstruction(packet, now = Date.now()) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    throw new InstructionError("invalid_instruction", 400);
  }
  if (packet.version !== 1) {
    throw new InstructionError("unsupported_version", 400);
  }

  const issuedAt = parseTimestamp(packet.issued_at, "invalid_issued_at");
  const expiresAt = parseTimestamp(packet.expires_at, "invalid_expires_at");
  if (expiresAt <= now) {
    throw new InstructionError("instruction_expired", 401);
  }
  if (expiresAt <= issuedAt) {
    throw new InstructionError("invalid_expiry_window", 400);
  }
  if (expiresAt - issuedAt > MAX_EXPIRY_WINDOW_MS) {
    throw new InstructionError("expiry_window_too_large", 400);
  }
  if (expiresAt - now > MAX_EXPIRY_WINDOW_MS) {
    throw new InstructionError("expiry_window_too_large", 400);
  }
  if (issuedAt > now + 60_000) {
    throw new InstructionError("issued_at_in_future", 400);
  }

  if (!isNonEmptyString(packet.kid)) {
    throw new InstructionError("missing_kid", 400);
  }
  if (!isNonEmptyString(packet.nonce)) {
    throw new InstructionError("missing_nonce", 400);
  }
  if (!isNonEmptyString(packet.op)) {
    throw new InstructionError("missing_op", 400);
  }
  if (!isNonEmptyString(packet.signature)) {
    throw new InstructionError("missing_signature", 401);
  }

  evictOldNonces(now);
  if (nonceStore.has(packet.nonce)) {
    throw new InstructionError("replay_detected", 409);
  }

  const state = loadState();
  const controlPlanePublicKey = state.controlPlanePublicKey || process.env.SPINNY_CONTROL_PLANE_PUBLIC_KEY;
  if (!controlPlanePublicKey) {
    throw new InstructionError("missing_control_plane_key", 401);
  }

  const signedPayload = instructionSignaturePayload(packet);
  if (!verifySignedPayload(controlPlanePublicKey, signedPayload, packet.signature)) {
    throw new InstructionError("invalid_signature", 401);
  }
  nonceStore.set(packet.nonce, now);

  const localPolicy = loadPrivacyPolicy();
  const { policy, policyTightened } = intersectPrivacyPolicies(packet.policy, localPolicy);
  if (policyTightened) {
    console.log(`[instruction] privacy firewall tightened policy for op=${packet.op} nonce=${packet.nonce}`);
  }

  return {
    packet,
    op: packet.op,
    payload: packet.payload || {},
    policy,
    policyTightened,
    instructionHash: instructionHash(packet)
  };
}

export async function executeInstruction(prepared, { onStream } = {}) {
  let stats = {};
  try {
    let body;
    if (prepared.op === "infer.run") {
      const result = await runInfer(prepared.payload, { onStream });
      stats = { raw_data_left_device: false, snippets_returned: 0, files_accessed: 0 };
      body = result;
    } else if (prepared.op === "memory.store") {
      body = storeMemoryObject(prepared.payload);
      stats = { raw_data_left_device: false, snippets_returned: 0, files_accessed: 0 };
    } else if (prepared.op === "context.retrieve") {
      body = retrieveMemoryObjects(prepared.payload, prepared.policy);
      stats = {
        raw_data_left_device: false,
        snippets_returned: body.snippets_returned || 0,
        files_accessed: 0
      };
      delete body.snippets_returned;
    } else if (prepared.op === "vault.read_preview") {
      body = readVaultPreviews();
      stats = { raw_data_left_device: false, snippets_returned: 0, files_accessed: 0 };
    } else {
      throw new InstructionError("unknown_op", 400);
    }

    const receipt = recordInstructionReceipt(prepared, stats);
    return { status: 200, body: { ...body, receipt }, receipt };
  } catch (error) {
    const instructionError = error instanceof InstructionError
      ? error
      : new InstructionError("instruction_failed", 500, error.message);
    const receipt = recordInstructionReceipt(prepared, {
      ...stats,
      error: instructionError.code,
      raw_data_left_device: false,
      snippets_returned: stats.snippets_returned || 0,
      files_accessed: stats.files_accessed || 0
    });
    instructionError.receipt = receipt;
    throw instructionError;
  }
}

export function recordRejectedInstruction(packet, code = "instruction_rejected") {
  const receipt = {
    instruction_hash: packet && typeof packet === "object" ? instructionHash(packet) : null,
    op: packet && typeof packet === "object" ? packet.op || null : null,
    nonce: packet && typeof packet === "object" ? packet.nonce || null : null,
    executed_at: new Date().toISOString(),
    raw_data_left_device: false,
    snippets_returned: 0,
    files_accessed: 0,
    firewall_policy_applied: "strict",
    policy_tightened: false,
    error: code
  };
  appendReceipt(receipt);
  return receipt;
}

function runInfer(payload, { onStream } = {}) {
  return (async () => {
    const {
      model,
      messages,
      system_prompt: systemPrompt,
      systemPrompt: camelSystemPrompt,
      options,
      retrieve_examples: retrieveExamples,
      query,
      domain_tags: domainTags,
      example_limit: exampleLimit
    } = payload || {};
    if (!isNonEmptyString(model) || !Array.isArray(messages)) {
      throw new InstructionError("invalid_infer_payload", 400, "infer.run requires payload.model and payload.messages");
    }
    if (!/^[a-zA-Z0-9._:/-]+$/.test(model)) {
      throw new InstructionError("invalid_model", 400);
    }

    const prompt = systemPrompt || camelSystemPrompt || "";
    let examples = [];
    if (retrieveExamples === true && isNonEmptyString(query)) {
      examples = retrieveApprenticeshipExamples({
        query,
        domain_tags: Array.isArray(domainTags) ? domainTags : [],
        limit: exampleLimit || 3
      }, {
        includeRaw: true,
        maxSnippetChars: 50000,
        incrementUse: true
      }).examples;
    }
    const examplesBlock = examples.length ? formatApprovedExamples(examples) : "";
    const finalSystemPrompt = examplesBlock ? `${examplesBlock}\n\n${prompt}` : prompt;
    const finalMessages = finalSystemPrompt
      ? [{ role: "system", content: String(finalSystemPrompt) }, ...messages]
      : messages;
    const isThinkingModel = /qwen3|deepseek-r|qwq/i.test(model);
    const body = {
      model,
      messages: finalMessages,
      stream: true,
      keep_alive: -1,
      ...(isThinkingModel ? { think: false } : {}),
      ...(options && typeof options === "object" && !Array.isArray(options) ? { options } : {})
    };

    const ollamaRes = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!ollamaRes.ok || !ollamaRes.body) {
      throw new InstructionError("ollama_error", 502, `Ollama error ${ollamaRes.status}: is the model installed?`);
    }

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          const piece = chunk.message?.content ?? "";
          content += piece;
          onStream?.({ content: piece, done: chunk.done ?? false });
        } catch {}
      }
    }
    const exampleMeta = {
      examples_used: examples.length,
      used_example_ids: examples.map((example) => example.id)
    };
    return onStream ? { ok: true, ...exampleMeta } : { content, ...exampleMeta };
  })();
}

function storeMemoryObject(payload) {
  const type = payload?.type;
  const object = payload?.object;
  if (type !== APPRENTICESHIP_TYPE) {
    throw new InstructionError("unsupported_memory_type", 400);
  }
  const example = normalizeApprenticeshipExample(object);
  appendJsonLine(apprenticeshipPath(), example);
  return { stored: true, id: example.id };
}

function retrieveMemoryObjects(payload, policy) {
  const includeRaw = policy.allow_raw_text_return === true;
  const result = retrieveApprenticeshipExamples(payload, {
    includeRaw,
    maxSnippetChars: policy.max_snippet_chars,
    incrementUse: true
  });
  return {
    examples: result.examples,
    snippets_returned: includeRaw ? result.examples.length : 0
  };
}

export function memoryStats() {
  const examples = readLatestApprenticeshipExamples();
  const byScope = {};
  let expired = 0;
  let escalationTasksNowLocal = 0;
  for (const example of examples) {
    byScope[example.scope] = (byScope[example.scope] || 0) + 1;
    if (isExpired(example)) expired += 1;
    if ((example.use_count || 0) >= 3) escalationTasksNowLocal += 1;
  }
  return {
    total_examples: examples.length,
    by_scope: byScope,
    expired,
    escalation_tasks_now_local: escalationTasksNowLocal
  };
}

function retrieveApprenticeshipExamples(payload, {
  includeRaw = false,
  maxSnippetChars = DEFAULT_PRIVACY_POLICY.max_snippet_chars,
  incrementUse = false
} = {}) {
  const query = String(payload?.query || "");
  const requestedTags = new Set(stringArray(payload?.domain_tags).map((tag) => tag.toLowerCase()));
  const limit = clampNumber(payload?.limit, 3, 1, 20);
  const queryWords = tokenSet(query);
  const now = new Date().toISOString();

  const scored = readLatestApprenticeshipExamples()
    .filter((example) => example.use_rules?.can_inject_into_local_prompt === true)
    .filter((example) => !isExpired(example))
    .map((example) => {
      let score = 0;
      const exampleTags = new Set(stringArray(example.input_signature?.domain_tags).map((tag) => tag.toLowerCase()));
      for (const tag of requestedTags) if (exampleTags.has(tag)) score += 2;
      const summaryWords = tokenSet(example.few_shot?.user_request_summary || "");
      for (const word of queryWords) if (summaryWords.has(word)) score += 1;
      return { example, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || String(b.example.stored_at).localeCompare(String(a.example.stored_at)))
    .slice(0, limit);

  const updated = scored.map(({ example, score }) => ({
    ...example,
    use_count: incrementUse ? (example.use_count || 0) + 1 : (example.use_count || 0),
    last_used_at: incrementUse ? now : example.last_used_at,
    score
  }));

  if (incrementUse) {
    for (const example of updated) {
      const { score, ...stored } = example;
      appendJsonLine(apprenticeshipPath(), stored);
    }
  }

  return {
    examples: updated.map((example) => includeRaw
      ? truncateStrings(example, maxSnippetChars)
      : publicExampleMetadata(example))
  };
}

function normalizeApprenticeshipExample(object) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    throw new InstructionError("invalid_apprenticeship_example", 400);
  }

  const now = new Date().toISOString();
  const example = {
    id: isNonEmptyString(object.id) ? object.id : randomUUID(),
    type: object.type || APPRENTICESHIP_TYPE,
    stored_at: isNonEmptyString(object.stored_at) ? object.stored_at : now,
    scope: object.scope,
    source: object.source,
    input_signature: {
      task_type: object.input_signature?.task_type,
      domain_tags: stringArray(object.input_signature?.domain_tags)
    },
    few_shot: {
      user_request_summary: object.few_shot?.user_request_summary,
      approved_response: object.few_shot?.approved_response,
      style_notes: stringArray(object.few_shot?.style_notes)
    },
    use_rules: {
      can_inject_into_local_prompt: object.use_rules?.can_inject_into_local_prompt === true,
      expires_at: object.use_rules?.expires_at ?? null,
      sensitivity: object.use_rules?.sensitivity || "local_only",
      cloud_visible: object.use_rules?.cloud_visible === true
    },
    use_count: clampNumber(object.use_count, 0, 0, Number.MAX_SAFE_INTEGER),
    last_used_at: object.last_used_at ?? null
  };

  if (example.type !== APPRENTICESHIP_TYPE) throw new InstructionError("invalid_apprenticeship_type", 400);
  if (!isNonEmptyString(example.scope)) throw new InstructionError("invalid_apprenticeship_scope", 400);
  if (!isNonEmptyString(example.source)) throw new InstructionError("invalid_apprenticeship_source", 400);
  if (!isNonEmptyString(example.input_signature.task_type)) throw new InstructionError("invalid_apprenticeship_task_type", 400);
  if (!isNonEmptyString(example.few_shot.user_request_summary)) throw new InstructionError("invalid_apprenticeship_summary", 400);
  if (!isNonEmptyString(example.few_shot.approved_response)) throw new InstructionError("invalid_apprenticeship_response", 400);
  if (example.use_rules.sensitivity !== "local_only") throw new InstructionError("invalid_apprenticeship_sensitivity", 400);
  if (example.use_rules.cloud_visible !== false) throw new InstructionError("invalid_apprenticeship_visibility", 400);
  if (example.use_rules.expires_at !== null && !Number.isFinite(Date.parse(example.use_rules.expires_at))) {
    throw new InstructionError("invalid_apprenticeship_expiry", 400);
  }
  if (example.last_used_at !== null && !Number.isFinite(Date.parse(example.last_used_at))) {
    throw new InstructionError("invalid_apprenticeship_last_used_at", 400);
  }
  if (!Number.isFinite(Date.parse(example.stored_at))) {
    throw new InstructionError("invalid_apprenticeship_stored_at", 400);
  }

  return example;
}

function readLatestApprenticeshipExamples() {
  const latest = new Map();
  for (const entry of readJsonLines(apprenticeshipPath())) {
    if (entry?.type === APPRENTICESHIP_TYPE && isNonEmptyString(entry.id)) {
      latest.set(entry.id, entry);
    }
  }
  return Array.from(latest.values());
}

function formatApprovedExamples(examples) {
  const rendered = examples.map((example) => [
    `Task: ${example.few_shot.user_request_summary}`,
    `Response: ${example.few_shot.approved_response}`,
    `Style: ${stringArray(example.few_shot.style_notes).join(", ")}`,
    `---`
  ].join("\n"));
  return `[APPROVED EXAMPLES]\n${rendered.join("\n")}\n[END EXAMPLES]`;
}

function publicExampleMetadata(example) {
  return {
    id: example.id,
    type: example.type,
    stored_at: example.stored_at,
    scope: example.scope,
    source: example.source,
    input_signature: example.input_signature,
    use_rules: {
      can_inject_into_local_prompt: example.use_rules?.can_inject_into_local_prompt === true,
      expires_at: example.use_rules?.expires_at ?? null,
      sensitivity: example.use_rules?.sensitivity || "local_only",
      cloud_visible: example.use_rules?.cloud_visible === true
    },
    use_count: example.use_count || 0,
    last_used_at: example.last_used_at || null,
    score: example.score || 0
  };
}

function isExpired(example) {
  const expiresAt = example?.use_rules?.expires_at;
  return isNonEmptyString(expiresAt) && Date.parse(expiresAt) <= Date.now();
}

function readVaultPreviews() {
  const vault = new Vault();
  try {
    const keys = vault.list(VAULT_NS, 50).map(({ key: provider, value }) => ({
      provider,
      preview: value?.key ? maskKey(value.key) : "****",
      storedAt: value?.storedAt || null
    }));
    return { keys };
  } finally {
    vault.close();
  }
}

function recordInstructionReceipt(prepared, stats = {}) {
  const receipt = {
    instruction_hash: prepared.instructionHash,
    op: prepared.op,
    nonce: prepared.packet.nonce,
    executed_at: new Date().toISOString(),
    raw_data_left_device: stats.raw_data_left_device === true,
    snippets_returned: stats.snippets_returned || 0,
    files_accessed: stats.files_accessed || 0,
    firewall_policy_applied: "strict",
    policy_tightened: prepared.policyTightened === true,
    ...(stats.error ? { error: stats.error } : {})
  };
  appendReceipt(receipt);
  return receipt;
}

function instructionSignaturePayload(packet) {
  return {
    version: packet.version,
    kid: packet.kid,
    nonce: packet.nonce,
    issued_at: packet.issued_at,
    expires_at: packet.expires_at,
    op: packet.op,
    policy: packet.policy || {},
    payload: packet.payload || {}
  };
}

function verifySignedPayload(publicKeyDer, payload, signature) {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyDer, "base64"),
      type: "spki",
      format: "der"
    });
    return verify(null, Buffer.from(canonicalJson(payload), "utf8"), publicKey, base64UrlToBuffer(signature));
  } catch {
    return false;
  }
}

function intersectPrivacyPolicies(requested, local) {
  const requestedPolicy = normalizePrivacyPolicy(requested);
  const localPolicy = normalizePrivacyPolicy(local);
  const policy = { ...DEFAULT_PRIVACY_POLICY };
  for (const field of BOOLEAN_POLICY_FIELDS) {
    policy[field] = requestedPolicy[field] === true && localPolicy[field] === true;
  }
  policy.max_snippet_chars = Math.min(requestedPolicy.max_snippet_chars, localPolicy.max_snippet_chars);
  return {
    policy,
    policyTightened: canonicalJson(policy) !== canonicalJson(requestedPolicy)
  };
}

function normalizePrivacyPolicy(policy = {}) {
  const source = policy && typeof policy === "object" && !Array.isArray(policy) ? policy : {};
  const next = { ...DEFAULT_PRIVACY_POLICY };
  for (const field of BOOLEAN_POLICY_FIELDS) {
    next[field] = typeof source[field] === "boolean" ? source[field] : DEFAULT_PRIVACY_POLICY[field];
  }
  next.max_snippet_chars = clampNumber(source.max_snippet_chars, DEFAULT_PRIVACY_POLICY.max_snippet_chars, 0, 50_000);
  return next;
}

function parseTimestamp(value, code) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new InstructionError(code, 400);
  }
  return time;
}

function evictOldNonces(now) {
  for (const [nonce, seenAt] of nonceStore) {
    if (now - seenAt > NONCE_RETENTION_MS) nonceStore.delete(nonce);
  }
}

function instructionHash(packet) {
  return createHash("sha256").update(canonicalJson(packet), "utf8").digest("hex");
}

function base64UrlToBuffer(value) {
  const text = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function appendReceipt(receipt) {
  const path = receiptsPath();
  appendJsonLine(path, receipt);
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length > MAX_RECEIPTS) {
    writeFileSync(path, `${lines.slice(-MAX_RECEIPTS).join("\n")}\n`, "utf8");
  }
}

function appendJsonLine(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function privacyPath() {
  return join(spinnyHome(), "privacy.json");
}

function receiptsPath() {
  return join(spinnyHome(), "receipts.jsonl");
}

function genericMemoryPath() {
  return join(spinnyHome(), "memory", "objects.jsonl");
}

function apprenticeshipPath() {
  return join(spinnyHome(), "memory", "apprenticeship.jsonl");
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function tokenSet(value) {
  return new Set(String(value).toLowerCase().match(/[a-z0-9_:-]+/g) || []);
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function truncateStrings(value, maxChars) {
  if (typeof value === "string") {
    return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
  }
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, maxChars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateStrings(item, maxChars)]));
  }
  return value;
}

function maskKey(key) {
  if (!key || key.length < 8) return "****";
  return `${key.slice(0, 8)}****`;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
