export const CLIENT_VERSION = "0.1.0";
export const PROTOCOL_VERSION = 1;
export const TASK_MAX_AGE_MS = 5 * 60 * 1000;

export function assertFreshIssuedAt(issuedAt, now = Date.now()) {
  if (!issuedAt) throw new Error("Missing issuedAt");
  const issuedTime = Date.parse(issuedAt);
  if (!Number.isFinite(issuedTime)) throw new Error("Invalid issuedAt");
  if (Math.abs(now - issuedTime) > TASK_MAX_AGE_MS) throw new Error("Task envelope is outside freshness window");
}

export function nodeHello({ state, relaySessionToken, nodePublicKey }) {
  return {
    type: "node.hello",
    protocolVersion: PROTOCOL_VERSION,
    clientVersion: CLIENT_VERSION,
    nodeId: state.nodeId,
    relaySessionToken,
    nodePublicKey,
    issuedAt: new Date().toISOString()
  };
}

export function taskResult({ taskId, status, result = null, error = null }) {
  return {
    type: "task.result",
    taskId,
    status,
    result,
    error,
    issuedAt: new Date().toISOString()
  };
}

export function taskProgress({ taskId, status, detail = null }) {
  return {
    type: "task.progress",
    taskId,
    status,
    detail,
    issuedAt: new Date().toISOString()
  };
}
