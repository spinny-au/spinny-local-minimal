import { OllamaClient } from "./ollama.js";
import { loadState } from "./state.js";
import { taskProgress, taskResult } from "./protocol.js";
import { Vault } from "./vault.js";
import { importModelBundleFromUrl } from "./model-bundles.js";
import { getSystemInfo } from "./system-info.js";
import { getLines } from "./log-buffer.js";
import {
  captureFeedback,
  completeGmailOAuth,
  deleteGmailCredentials,
  emailMetrics,
  emailStatus,
  executeEmailAction,
  configureTelegram,
  feedbackInsights,
  getGmailCredentials,
  initGmailOAuth,
  monitorEmails,
  pauseEmailAutomation,
  planEmailAutomation,
  resumeEmailAutomation,
  saveGmailCredentials,
  sendTelegramNotification,
  storeGmailTokens
} from "./email-vertical.js";
import {
  deploySubagent,
  listSubagents,
  pauseSubagent,
  resumeSubagent,
  removeSubagent,
} from './subagent-scheduler.js'

export async function handleTask(task, { send, ollama = new OllamaClient() } = {}) {
  const state = loadState();
  if (!state.paired) throw new Error("Node is not paired");
  if (task.nodeId !== state.nodeId) throw new Error("Task is addressed to a different node");

  if (task.type === "model.install") {
    const model = task.params?.model;
    if (!model) throw new Error("model.install task missing params.model");
    let last = null;
    await send?.(taskProgress({ taskId: task.taskId, status: "pulling", detail: { model } }));
    if (typeof ollama.pullModelStream === "function") {
      for await (const progress of ollama.pullModelStream(model)) {
        last = progress;
        await send?.(taskProgress({ taskId: task.taskId, status: "pulling", detail: progress }));
      }
    } else {
      last = await ollama.pullModel(model);
    }
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result: last || { ok: true, model } }));
    return last || { ok: true, model };
  }

  if (task.type === "model.transferFrom") {
    const model = task.params?.model;
    const sourceUrl = task.params?.sourceUrl;
    if (!model || !sourceUrl) throw new Error("model.transferFrom missing params.model or params.sourceUrl");
    await send?.(taskProgress({ taskId: task.taskId, status: "transferring", detail: { model } }));
    const result = await importModelBundleFromUrl(sourceUrl, model);
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "llm.generate") {
    const result = await ollama.generate(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "vault.put") {
    const { namespace, key, value } = task.params || {};
    if (!isSupportedVaultNamespace(namespace)) throw new Error("Unsupported vault namespace");
    if (!key) throw new Error("vault.put missing params.key");
    const vault = new Vault();
    try {
      vault.put(namespace, key, value);
    } finally {
      vault.close();
    }
    const result = { ok: true, namespace, key };
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "vault.list") {
    const { namespace, limit } = task.params || {};
    if (!isSupportedVaultNamespace(namespace)) throw new Error("Unsupported vault namespace");
    const vault = new Vault();
    try {
      const result = vault.list(namespace, limit || 20);
      await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
      return result;
    } finally {
      vault.close();
    }
  }

  if (task.type === "vertical.attach") {
    const result = attachVertical(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "vertical.detach") {
    const result = detachVertical(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "vertical.status") {
    const result = verticalStatus(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.status") {
    const result = emailStatus();
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.metrics") {
    const result = emailMetrics();
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.pause") {
    const result = pauseEmailAutomation(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.resume") {
    const result = resumeEmailAutomation();
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.oauth.tokens") {
    const result = storeGmailTokens(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.credentials.save") {
    const result = saveGmailCredentials(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.credentials.get") {
    const result = getGmailCredentials();
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.credentials.delete") {
    const result = deleteGmailCredentials();
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.oauth.init") {
    const result = initGmailOAuth(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.oauth.callback") {
    const result = await completeGmailOAuth(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.plan") {
    const result = planEmailAutomation(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.monitor") {
    const result = await monitorEmails(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.action") {
    const result = await executeEmailAction(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.feedback") {
    const result = captureFeedback(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.feedback.insights") {
    const result = feedbackInsights();
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "vertical.subagent.deploy") {
    const result = deploySubagent(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "vertical.subagent.list") {
    const result = listSubagents();
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "vertical.subagent.pause") {
    const result = pauseSubagent(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "vertical.subagent.resume") {
    const result = resumeSubagent(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "vertical.subagent.remove") {
    const result = removeSubagent(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.telegram.configure") {
    const result = configureTelegram(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "email.telegram.send") {
    const result = await sendTelegramNotification(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "node.system_info") {
    const info = getSystemInfo();
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result: info }));
    return info;
  }

  if (task.type === "node.logs") {
    const limit = Math.min(200, Math.max(1, Number(task.params?.limit) || 100));
    const lines = getLines(limit);
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result: { lines } }));
    return { lines };
  }

  throw new Error(`Unsupported task type: ${task.type}`);
}

function isSupportedVaultNamespace(namespace) {
  return ["context_fabric", "memory", "wiki", "verticals", "email_vertical", "subagents"].includes(namespace);
}

function attachVertical(params) {
  const manifest = params.manifest;
  const name = manifest?.name || params.name;
  if (!isValidVerticalName(name)) throw new Error("vertical.attach missing valid manifest.name");
  const vault = new Vault();
  try {
    const existing = vault.get("verticals", name) || {};
    const record = {
      ...existing,
      name,
      version: manifest?.version || params.version || "",
      manifest: manifest || existing.manifest || null,
      status: "attached",
      attachedAt: existing.attachedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dataLocality: {
        emailContentLeavesNode: false,
        credentialsStoredInLocalVault: true,
        cloudReceivesEncryptedSummariesOnly: true
      }
    };
    vault.put("verticals", name, record);
    return publicVerticalRecord(record);
  } finally {
    vault.close();
  }
}

function detachVertical(params) {
  const name = params.name || params.verticalName;
  if (!isValidVerticalName(name)) throw new Error("vertical.detach missing valid name");
  const vault = new Vault();
  try {
    const existing = vault.get("verticals", name) || { name };
    const record = {
      ...existing,
      status: "detached",
      detachedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    vault.put("verticals", name, record);
    return publicVerticalRecord(record);
  } finally {
    vault.close();
  }
}

function verticalStatus(params) {
  const name = params.name || params.verticalName || "";
  const vault = new Vault();
  try {
    if (name) {
      if (!isValidVerticalName(name)) throw new Error("vertical.status invalid name");
      const record = vault.get("verticals", name);
      return { vertical: record ? publicVerticalRecord(record) : null };
    }
    return {
      verticals: vault.list("verticals", 100).map(({ value }) => publicVerticalRecord(value))
    };
  } finally {
    vault.close();
  }
}

function publicVerticalRecord(record) {
  if (!record) return null;
  return {
    name: record.name,
    version: record.version || "",
    status: record.status || "unknown",
    attachedAt: record.attachedAt || null,
    updatedAt: record.updatedAt || null,
    detachedAt: record.detachedAt || null,
    capabilities: record.manifest?.capabilities || [],
    dataLocality: record.dataLocality || null
  };
}

function isValidVerticalName(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value);
}
