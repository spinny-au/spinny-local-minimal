import { Vault } from "./vault.js";
import { LlmManager, estimateTokens } from "./llm-manager.js";
import { MemoryLayer } from "./memory-layer.js";
import { readFile, writeFile, patchFile, listDir, gitStatus, gitBranch, gitCommit, gitPush, npmRun } from "./tools.js";

const VAULT_NS = "byok";
const MAX_ITERATIONS = 20;

// ── Tool definitions (OpenAI function-calling format) ──────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "filesystem_read",
      description: "Read the contents of a file. Use this before editing to understand the current code.",
      parameters: {
        type: "object",
        properties: {
          repoRoot: { type: "string", description: "Absolute path to the repository root" },
          filePath: { type: "string", description: "Path to the file, relative to repo root" },
        },
        required: ["repoRoot", "filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "filesystem_write",
      description: "Write content to a file. Creates parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          repoRoot: { type: "string", description: "Absolute path to the repository root" },
          filePath: { type: "string", description: "Path to the file, relative to repo root" },
          content: { type: "string", description: "Complete file content to write" },
        },
        required: ["repoRoot", "filePath", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "filesystem_patch",
      description: "Replace a specific string in a file. Use for targeted edits without rewriting the whole file.",
      parameters: {
        type: "object",
        properties: {
          repoRoot: { type: "string", description: "Absolute path to the repository root" },
          filePath: { type: "string", description: "Path to the file, relative to repo root" },
          oldStr: { type: "string", description: "Exact string to find and replace" },
          newStr: { type: "string", description: "Replacement string" },
        },
        required: ["repoRoot", "filePath", "oldStr", "newStr"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "filesystem_list",
      description: "List files and directories in a path. Use to explore project structure.",
      parameters: {
        type: "object",
        properties: {
          repoRoot: { type: "string", description: "Absolute path to the repository root" },
          dirPath: { type: "string", description: "Directory path relative to repo root, default is '.'" },
        },
        required: ["repoRoot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Get the current git status: current branch, uncommitted changes, recent commits.",
      parameters: {
        type: "object",
        properties: {
          repoRoot: { type: "string", description: "Absolute path to the repository root" },
        },
        required: ["repoRoot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_branch",
      description: "Create and switch to a new git branch. Never use 'main' or 'master' as the branch name.",
      parameters: {
        type: "object",
        properties: {
          repoRoot: { type: "string", description: "Absolute path to the repository root" },
          name: { type: "string", description: "Branch name, e.g. 'spinny/feat/add-login'" },
          base: { type: "string", description: "Optional base branch, defaults to current branch" },
        },
        required: ["repoRoot", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Stage all changes and commit with a message.",
      parameters: {
        type: "object",
        properties: {
          repoRoot: { type: "string", description: "Absolute path to the repository root" },
          message: { type: "string", description: "Commit message" },
        },
        required: ["repoRoot", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_push",
      description: "Push the current branch to the remote origin.",
      parameters: {
        type: "object",
        properties: {
          repoRoot: { type: "string", description: "Absolute path to the repository root" },
          branch: { type: "string", description: "Branch name to push" },
        },
        required: ["repoRoot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "npm_run",
      description: "Run an npm script in the repository. Use 'build' to build, 'test' to run tests.",
      parameters: {
        type: "object",
        properties: {
          repoRoot: { type: "string", description: "Absolute path to the repository root" },
          script: { type: "string", description: "npm script name, e.g. 'build', 'test'" },
        },
        required: ["repoRoot", "script"],
      },
    },
  },
];

// ── Tool execution ──────────────────────────────────────────────────────────────

function executeTool(name, args) {
  switch (name) {
    case "filesystem_read":  return readFile(args.repoRoot, args.filePath);
    case "filesystem_write": return writeFile(args.repoRoot, args.filePath, args.content);
    case "filesystem_patch": return patchFile(args.repoRoot, args.filePath, args.oldStr, args.newStr);
    case "filesystem_list":  return { entries: listDir(args.repoRoot, args.dirPath || ".") };
    case "git_status":       return gitStatus(args.repoRoot);
    case "git_branch":       return gitBranch(args.repoRoot, args.name, args.base || undefined);
    case "git_commit":       return gitCommit(args.repoRoot, args.message);
    case "git_push":         return gitPush(args.repoRoot, args.branch);
    case "npm_run":          return npmRun(args.repoRoot, args.script);
    default:                 return { error: `Unknown tool: ${name}` };
  }
}

function toolResultContent(result) {
  if (result instanceof Promise) return "(async pending)";
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

// ── AI call ─────────────────────────────────────────────────────────────────────

async function callOpenAI(apiKey, model, messages, stream = false) {
  const body = { model, messages, stream };
  if (!stream) body.tools = TOOLS;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text().catch(() => "")}`);
  return stream ? res : res.json();
}

async function callAnthropic(apiKey, model, messages, systemPrompt) {
  const anthropicMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool") return { role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }] };
      if (m.tool_calls) {
        return {
          role: "assistant",
          content: m.tool_calls.map((tc) => ({
            type: "tool_use", id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || "{}"),
          })),
        };
      }
      return { role: m.role === "assistant" ? "assistant" : "user", content: m.content };
    });

  const anthropicTools = TOOLS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: {
      type: "object",
      properties: t.function.parameters.properties,
      required: t.function.parameters.required,
    },
  }));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, messages: anthropicMessages, ...(systemPrompt ? { system: systemPrompt } : {}), tools: anthropicTools, max_tokens: 8096 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

// ── Main agent loop ─────────────────────────────────────────────────────────────

export async function runAgent({ messages, provider = "openai", model = "gpt-4o", onEvent } = {}) {
  const onEvt = onEvent || (() => {});
  const vault = new Vault();
  let apiKey;

  try {
    const stored = vault.get(VAULT_NS, provider);
    apiKey = stored?.key;
    if (!apiKey) throw new Error(`No API key for ${provider}. Add one in Settings → API Manager.`);
  } finally {
    vault.close();
  }

  const workingMessages = [...messages];
  const systemIdx = workingMessages.findIndex((m) => m.role === "system");
  const systemPrompt = systemIdx >= 0 ? workingMessages.splice(systemIdx, 1)[0].content : "";

  let iteration = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    onEvt({ type: "iteration", iteration });

    let response;
    if (provider === "anthropic") {
      response = await callAnthropic(apiKey, model, workingMessages, systemPrompt || undefined);
    } else {
      response = await callOpenAI(apiKey, model, workingMessages, false);
    }

    const choice = response.choices?.[0]?.message || response;

    // Track usage
    if (response.usage) {
      totalInputTokens += response.usage.input_tokens || response.usage.inputTokens || 0;
      totalOutputTokens += response.usage.output_tokens || response.usage.outputTokens || 0;
    }

    // Check for Anthropic tool use
    if (provider === "anthropic" && Array.isArray(choice.content)) {
      const toolUses = choice.content.filter((c) => c.type === "tool_use");
      const textBlocks = choice.content.filter((c) => c.type === "text");

      if (toolUses.length > 0) {
        const toolCalls = toolUses.map((tu) => ({
          id: tu.id,
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        }));

        workingMessages.push({ role: "assistant", content: choice.content });
        onEvt({ type: "tool_calls", calls: toolCalls.map((tc) => ({ name: tc.function.name, args: tc.function.arguments })) });

        for (const tc of toolCalls) {
          try {
            const args = JSON.parse(tc.function.arguments);
            onEvt({ type: "tool_start", name: tc.function.name, args });
            const result = await executeTool(tc.function.name, args);
            const content = toolResultContent(result);
            onEvt({ type: "tool_result", name: tc.function.name, result: content.slice(0, 2000) });
            workingMessages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tc.id, content }] });
          } catch (err) {
            onEvt({ type: "tool_error", name: tc.function.name, error: err.message });
            workingMessages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tc.id, content: `Error: ${err.message}`, is_error: true }] });
          }
        }
        continue;
      }

      const text = textBlocks.map((b) => b.text || "").join("\n");
      onEvt({ type: "done", content: text, stats: { iterations: iteration, inputTokens: totalInputTokens, outputTokens: totalOutputTokens } });
      return { ok: true, content: text, stats: { iterations: iteration, inputTokens: totalInputTokens, outputTokens: totalOutputTokens } };
    }

    // Check for OpenAI tool calls
    if (choice.tool_calls && choice.tool_calls.length > 0) {
      workingMessages.push(choice);
      onEvt({ type: "tool_calls", calls: choice.tool_calls.map((tc) => ({ name: tc.function.name, args: tc.function.arguments })) });

      for (const tc of choice.tool_calls) {
        try {
          const args = JSON.parse(tc.function.arguments);
          onEvt({ type: "tool_start", name: tc.function.name, args });
          const result = await executeTool(tc.function.name, args);
          const content = toolResultContent(result);
          onEvt({ type: "tool_result", name: tc.function.name, result: content.slice(0, 2000) });
          workingMessages.push({ role: "tool", content, tool_call_id: tc.id });
        } catch (err) {
          onEvt({ type: "tool_error", name: tc.function.name, error: err.message });
          workingMessages.push({ role: "tool", content: `Error: ${err.message}`, tool_call_id: tc.id });
        }
      }
      continue;
    }

    // Final text response
    const textContent = choice.content || "";
    onEvt({ type: "done", content: textContent, stats: { iterations: iteration, inputTokens: totalInputTokens, outputTokens: totalOutputTokens } });
    return { ok: true, content: textContent, stats: { iterations: iteration, inputTokens: totalInputTokens, outputTokens: totalOutputTokens } };
  }

  return { ok: false, error: "Max iterations reached", stats: { iterations: MAX_ITERATIONS, inputTokens: totalInputTokens, outputTokens: totalOutputTokens } };
}
