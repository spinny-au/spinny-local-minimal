import { OllamaClient } from "./ollama.js";
import { loadState } from "./state.js";
import { taskProgress, taskResult } from "./protocol.js";
import { Vault } from "./vault.js";

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

  if (task.type === "llm.generate") {
    const result = await ollama.generate(task.params || {});
    await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
    return result;
  }

  if (task.type === "vault.put") {
    const { namespace, key, value } = task.params || {};
    if (!["context_fabric", "memory", "wiki"].includes(namespace)) throw new Error("Unsupported vault namespace");
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
    if (!["context_fabric", "memory", "wiki"].includes(namespace)) throw new Error("Unsupported vault namespace");
    const vault = new Vault();
    try {
      const result = vault.list(namespace, limit || 20);
      await send?.(taskResult({ taskId: task.taskId, status: "complete", result }));
      return result;
    } finally {
      vault.close();
    }
  }

  throw new Error(`Unsupported task type: ${task.type}`);
}
