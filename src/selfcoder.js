import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spinnyHome } from "./paths.js";
import { gitStatus, gitBranch, npmRun } from "./tools.js";

const WORKSPACE = join(spinnyHome(), "selfcoder");

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function safeBranchName(text) {
  const name = String(text).replace(/[^a-zA-Z0-9/_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  if (!name || name === "main" || name === "master") throw new Error("unsafe branch name");
  return name;
}

async function saveTask(task) {
  const dir = resolve(WORKSPACE);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${task.id}.json`), JSON.stringify({ ...task, updatedAt: new Date().toISOString() }, null, 2));
}

async function loadTask(taskId) {
  const raw = await readFile(join(resolve(WORKSPACE), `${taskId}.json`), "utf8");
  return JSON.parse(raw);
}

// ── Plan ────────────────────────────────────────────────────────────────────────

export async function selfcoderPlan(repoRoot, taskText) {
  const text = String(taskText || "").trim();
  const kind = text.toLowerCase().startsWith("fix") || text.toLowerCase().includes("bug") ? "fix"
    : text.includes("refactor") ? "refactor"
    : "feat";
  const slug = slugify(text).slice(0, 48) || "coding-task";

  const gitInfo = await gitStatus(repoRoot);
  const id = randomUUID();
  const branch = safeBranchName(`spinny/${kind}/${slug}-${id.slice(0, 6)}`);

  const plan = {
    id,
    repoRoot: resolve(repoRoot),
    task: text,
    branch,
    status: "awaiting_approval",
    snapshot: { branch: gitInfo.branch, dirty: gitInfo.dirty, capturedAt: new Date().toISOString() },
    plan: { kind, slug, summary: text },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await saveTask(plan);
  return plan;
}

// ── Approve ─────────────────────────────────────────────────────────────────────

export async function selfcoderApprove(taskId) {
  const task = await loadTask(taskId);
  if (task.status !== "awaiting_approval") {
    throw new Error(`Task ${taskId} is not awaiting approval (current: ${task.status})`);
  }

  // Create the feature branch
  await gitBranch(task.repoRoot, task.branch);

  task.status = "approved";
  task.approvedAt = new Date().toISOString();
  await saveTask(task);
  return task;
}

// ── Start (build + test) ────────────────────────────────────────────────────────

export async function selfcoderStart(taskId) {
  const task = await loadTask(taskId);
  if (task.status !== "approved") {
    return { blocked: true, reason: "plan_not_approved", message: "Plan must be approved before building." };
  }

  task.status = "building";
  await saveTask(task);

  const buildResult = await npmRun(task.repoRoot, "build");
  if (!buildResult.ok) {
    task.status = "build_failed";
    task.build = buildResult;
    await saveTask(task);
    return task;
  }

  task.status = "testing";
  await saveTask(task);

  const testResult = await npmRun(task.repoRoot, "test");
  task.build = buildResult;
  task.test = testResult;

  if (!testResult.ok) {
    task.status = "test_failed";
    await saveTask(task);
    return task;
  }

  task.status = "ready_for_review";
  await saveTask(task);
  return task;
}

// ── Status ──────────────────────────────────────────────────────────────────────

export async function selfcoderStatus() {
  const dir = resolve(WORKSPACE);
  let files = [];
  try { files = await readdir(dir); } catch { return { tasks: [] }; }
  const tasks = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try { tasks.push(JSON.parse(await readFile(join(dir, file), "utf8"))); } catch {}
  }
  return { tasks: tasks.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) };
}

// ── Reject ──────────────────────────────────────────────────────────────────────

export async function selfcoderReject(taskId) {
  const task = await loadTask(taskId);
  if (task.status === "approved" || task.status === "ready_for_review" || task.status === "build_failed" || task.status === "test_failed") {
    // Try to switch back to original branch
    const { gitStatus: gs } = await import("./tools.js");
    try {
      const current = await gs(task.repoRoot);
      if (current.branch === task.branch) {
        const { gitBranch: gb } = await import("./tools.js");
        await gb(task.repoRoot, "main"); // or original branch
      }
    } catch {}
  }
  task.status = "rejected";
  task.rejectedAt = new Date().toISOString();
  await saveTask(task);
  return task;
}
