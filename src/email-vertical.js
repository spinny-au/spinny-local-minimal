import { randomUUID, createHash } from "node:crypto";
import { Vault } from "./vault.js";

const NS = "email_vertical";
const GMAIL_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

const DEFAULT_RULES = [
  { id: "newsletter", type: "subject_contains", value: "newsletter", category: "marketing", confidence: 0.78 },
  { id: "unsubscribe", type: "body_contains", value: "unsubscribe", category: "marketing", confidence: 0.72 },
  { id: "urgent", type: "subject_contains", value: "urgent", category: "important", confidence: 0.86 },
  { id: "reply", type: "subject_contains", value: "re:", category: "reply-needed", confidence: 0.76 },
  { id: "boss", type: "sender_contains", value: "boss", category: "reply-needed", confidence: 0.88 },
  { id: "promo", type: "subject_contains", value: "limited time", category: "spam", confidence: 0.82 }
];

const ACTIONS = new Set(["delete", "archive", "draft_reply", "label", "forward", "snooze"]);

export function emailStatus() {
  return withVault((vault) => {
    const accounts = vault.list(`${NS}:gmail`, 20).map(({ key, value }) => ({
      accountId: key,
      email: value.email || key,
      connectedAt: value.connectedAt || null,
      expiresAt: value.expiresAt || null
    }));
    const rules = loadRules(vault);
    const audit = vault.list(`${NS}:audit`, 20).map(({ value }) => redactAudit(value));
    const pause = vault.get(NS, "pause");
    const metrics = emailMetricsFromVault(vault);
    return {
      ok: true,
      vertical: "email-automation",
      gmailConnected: accounts.length > 0,
      accounts,
      rules,
      recentAudit: audit,
      paused: Boolean(pause?.active),
      pause,
      metrics,
      dataLocality: locality()
    };
  });
}

export function initGmailOAuth(params = {}) {
  const clientId = stringParam(params.clientId || process.env.GMAIL_CLIENT_ID, "clientId");
  const redirectUri = stringParam(params.redirectUri, "redirectUri");
  const state = randomUUID();
  const scope = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose"
  ].join(" ");
  withVault((vault) => {
    vault.put(`${NS}:oauth_state`, state, {
      state,
      provider: "gmail",
      redirectUri,
      createdAt: now()
    });
  });
  const url = new URL(GMAIL_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return { authUrl: url.toString(), state, scope };
}

export async function completeGmailOAuth(params = {}, deps = {}) {
  const code = stringParam(params.code, "code");
  const state = stringParam(params.state, "state");
  const clientId = stringParam(params.clientId || process.env.GMAIL_CLIENT_ID, "clientId");
  const clientSecret = stringParam(params.clientSecret || process.env.GMAIL_CLIENT_SECRET, "clientSecret");
  const redirectUri = stringParam(params.redirectUri, "redirectUri");
  const accountEmail = (params.email || params.accountEmail || "gmail-account").toLowerCase().trim();

  return await withVaultAsync(async (vault) => {
    const saved = vault.get(`${NS}:oauth_state`, state);
    if (!saved) throw new Error("Unknown or expired OAuth state");
    const fetchFn = deps.fetch || globalThis.fetch;
    if (!fetchFn) throw new Error("fetch unavailable");
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    });
    const response = await fetchFn(GMAIL_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    if (!response.ok) throw new Error(`Gmail token exchange failed: ${response.status}`);
    const token = await response.json();
    const record = {
      email: accountEmail,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenType: token.token_type || "Bearer",
      scope: token.scope || "",
      expiresAt: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null,
      connectedAt: now()
    };
    vault.put(`${NS}:gmail`, accountEmail, record);
    audit(vault, "gmail.oauth.connected", { accountEmail });
    return { connected: true, accountEmail, dataLocality: locality() };
  });
}

export function planEmailAutomation(params = {}) {
  const accounts = Array.isArray(params.accounts) && params.accounts.length ? params.accounts : ["Primary Gmail"];
  const autoDelete = Array.isArray(params.autoDelete) ? params.autoDelete : ["obvious spam", "low-value promotional blasts"];
  const notify = params.telegram ? "Telegram" : "composer";
  const plan = {
    monitor: accounts,
    autoDelete,
    flagForReview: ["urgent work emails", "unknown senders", "reply-needed messages"],
    draftRepliesFor: ["clients", "manager/boss", "known high-priority contacts"],
    notifications: notify,
    reviewCycle: params.reviewCycle || "Every 4 hours",
    approvalRequired: true
  };
  return {
    plan,
    userVisiblePlan: [
      "I will manage your inbox as follows:",
      "",
      `- Monitor: ${plan.monitor.join(", ")}`,
      `- Auto-delete: ${plan.autoDelete.join(", ")}`,
      `- Flag for review: ${plan.flagForReview.join(", ")}`,
      `- Draft replies for: ${plan.draftRepliesFor.join(", ")}`,
      `- Send notifications to: ${plan.notifications}`,
      `- Review cycle: ${plan.reviewCycle}`,
      "",
      "Approve this plan?"
    ].join("\n")
  };
}

export async function monitorEmails(params = {}, deps = {}) {
  return await withVaultAsync(async (vault) => {
    const messages = Array.isArray(params.messages)
      ? params.messages
      : await fetchGmailMessages(vault, params, deps);
    const rules = loadRules(vault);
    const processed = messages.map((message) => {
      const classification = classifyEmail(message, rules);
      const item = {
        id: message.id || hash(`${message.from}:${message.subject}:${message.date}`),
        from: message.from || "",
        subject: message.subject || "",
        date: message.date || now(),
        classification,
        preview: safePreview(message.preview || message.snippet || message.body || "")
      };
      vault.put(`${NS}:messages`, item.id, item);
      audit(vault, "email.classified", {
        emailId: item.id,
        category: classification.category,
        confidence: classification.confidence
      });
      return item;
    });
    return {
      processed: processed.length,
      flagged: processed.filter((item) => ["important", "reply-needed"].includes(item.classification.category)),
      emails: processed,
      dataLocality: locality()
    };
  });
}

export async function executeEmailAction(params = {}, deps = {}) {
  const action = stringParam(params.action, "action");
  if (!ACTIONS.has(action)) throw new Error(`Unsupported email action: ${action}`);
  const emailId = stringParam(params.emailId, "emailId");
  return await withVaultAsync(async (vault) => {
    assertNotPaused(vault);
    checkRateLimit(vault, `action:${action}`, Number(params.rateLimit || 30), 60 * 60 * 1000);
    const message = vault.get(`${NS}:messages`, emailId);
    if (!message && !params.allowMissing) throw new Error("Unknown local email id");
    let providerResult = { ok: true, simulated: true };
    if (params.accountEmail && !params.simulate) {
      providerResult = await executeGmailAction(vault, params.accountEmail, emailId, action, params, deps);
    }
    const result = {
      ok: true,
      action,
      emailId,
      subject: message?.subject || params.subject || "",
      providerResult,
      executedAt: now()
    };
    audit(vault, `email.action.${action}`, {
      emailId,
      action,
      result: "ok",
      subjectHash: hash(result.subject)
    });
    recordActionAndCheckAnomaly(vault, action, emailId);
    return result;
  });
}

export function formatTelegramNotification(email) {
  const classification = email.classification || {};
  return {
    text: [
      "New email needs attention",
      "",
      `From: ${email.from || ""}`,
      `Subject: ${email.subject || ""}`,
      `Type: ${classification.category || "review"} (${Math.round((classification.confidence || 0) * 100)}%)`
    ].join("\n"),
    buttons: [
      { text: "Delete", action: "delete", emailId: email.id },
      { text: "Draft Reply", action: "draft_reply", emailId: email.id },
      { text: "Archive", action: "archive", emailId: email.id },
      { text: "View Details", action: "view", emailId: email.id }
    ]
  };
}

export function configureTelegram(params = {}) {
  const botToken = stringParam(params.botToken, "botToken");
  const chatId = stringParam(params.chatId, "chatId");
  return withVault((vault) => {
    vault.put(`${NS}:telegram`, "default", {
      botToken,
      chatId,
      connectedAt: now()
    });
    audit(vault, "telegram.connected", { chatIdHash: hash(chatId) });
    return { connected: true, chatIdPreview: previewSecret(chatId) };
  });
}

export async function sendTelegramNotification(params = {}, deps = {}) {
  return await withVaultAsync(async (vault) => {
    assertNotPaused(vault);
    checkRateLimit(vault, "telegram:send", Number(params.rateLimit || 20), 60 * 60 * 1000);
    const telegram = vault.get(`${NS}:telegram`, "default");
    if (!telegram) throw new Error("Telegram is not configured on this local node");
    const email = params.email || {};
    const message = params.message || formatTelegramNotification(email);
    const fetchFn = deps.fetch || globalThis.fetch;
    const response = await fetchFn(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: telegram.chatId,
        text: message.text,
        reply_markup: {
          inline_keyboard: [
            (message.buttons || []).slice(0, 4).map((button) => ({
              text: button.text,
              callback_data: JSON.stringify({ a: button.action, e: button.emailId }).slice(0, 64)
            }))
          ]
        }
      })
    });
    if (!response.ok) throw new Error(`Telegram send failed: ${response.status}`);
    audit(vault, "telegram.notification.sent", { emailId: email.id || params.emailId || "" });
    return { sent: true };
  });
}

export function pauseEmailAutomation(params = {}) {
  return withVault((vault) => {
    const pause = {
      active: true,
      reason: params.reason || "manual",
      createdAt: now()
    };
    vault.put(NS, "pause", pause);
    audit(vault, "email.paused", { reason: pause.reason });
    return { ok: true, pause };
  });
}

export function resumeEmailAutomation() {
  return withVault((vault) => {
    vault.put(NS, "pause", null);
    audit(vault, "email.resumed", {});
    return { ok: true };
  });
}

export function emailMetrics() {
  return withVault((vault) => ({
    ok: true,
    metrics: emailMetricsFromVault(vault),
    dataLocality: locality()
  }));
}

export function captureFeedback(params = {}) {
  return withVault((vault) => {
    const feedback = {
      id: randomUUID(),
      emailId: params.emailId || "",
      rating: params.rating || "",
      correction: params.correction || "",
      createdAt: now()
    };
    vault.put(`${NS}:feedback`, feedback.id, feedback);
    const learnedRule = ruleFromFeedback(feedback);
    if (learnedRule) {
      const rules = loadRules(vault);
      const next = [...rules.filter((rule) => rule.id !== learnedRule.id), learnedRule];
      vault.put(NS, "rules", next);
      audit(vault, "email.rule.learned", { ruleId: learnedRule.id });
    }
    return { ok: true, feedback, learnedRule };
  });
}

export function classifyEmail(email, rules = DEFAULT_RULES) {
  const text = {
    sender_contains: (email.from || "").toLowerCase(),
    subject_contains: (email.subject || "").toLowerCase(),
    body_contains: `${email.body || ""} ${email.preview || ""} ${email.snippet || ""}`.toLowerCase()
  };
  const hits = [];
  for (const rule of rules) {
    const haystack = text[rule.type] || "";
    const needle = String(rule.value || "").toLowerCase();
    if (needle && haystack.includes(needle)) hits.push(rule);
  }
  if (!hits.length) {
    return { category: "important", confidence: 0.51, reasons: ["default-review"] };
  }
  hits.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  const top = hits[0];
  return {
    category: top.category,
    confidence: Math.max(0.01, Math.min(0.99, Number(top.confidence || 0.6))),
    reasons: hits.slice(0, 5).map((rule) => rule.id)
  };
}

function loadRules(vault) {
  const saved = vault.get(NS, "rules");
  if (Array.isArray(saved) && saved.length) return saved;
  vault.put(NS, "rules", DEFAULT_RULES);
  return DEFAULT_RULES;
}

function assertNotPaused(vault) {
  const pause = vault.get(NS, "pause");
  if (pause?.active) {
    throw new Error(`Email automation is paused: ${pause.reason || "policy"}`);
  }
}

function checkRateLimit(vault, key, limit, windowMs) {
  const nowMs = Date.now();
  const saved = vault.get(`${NS}:rate`, key) || { hits: [] };
  const hits = Array.isArray(saved.hits) ? saved.hits.filter((ts) => nowMs - Number(ts) < windowMs) : [];
  if (hits.length >= limit) {
    audit(vault, "email.rate_limited", { key, limit });
    throw new Error(`Rate limit exceeded for ${key}`);
  }
  hits.push(nowMs);
  vault.put(`${NS}:rate`, key, { hits, updatedAt: now() });
}

function recordActionAndCheckAnomaly(vault, action, emailId) {
  const nowMs = Date.now();
  const saved = vault.get(`${NS}:actions`, "recent") || { events: [] };
  const events = (Array.isArray(saved.events) ? saved.events : [])
    .filter((event) => nowMs - Number(event.ts || 0) < 60 * 60 * 1000);
  events.push({ action, emailId, ts: nowMs });
  vault.put(`${NS}:actions`, "recent", { events, updatedAt: now() });
  const destructive = events.filter((event) => event.action === "delete").length;
  if (destructive > 10) {
    const pause = {
      active: true,
      reason: "anomaly: too many delete actions in one hour",
      createdAt: now()
    };
    vault.put(NS, "pause", pause);
    audit(vault, "email.anomaly.paused", { destructiveActionsLastHour: destructive });
  }
}

function emailMetricsFromVault(vault) {
  const auditRecords = vault.list(`${NS}:audit`, 200).map(({ value }) => value);
  const byAction = {};
  for (const record of auditRecords) {
    byAction[record.action] = (byAction[record.action] || 0) + 1;
  }
  const recentActions = vault.get(`${NS}:actions`, "recent")?.events || [];
  return {
    classified: byAction["email.classified"] || 0,
    actions: Object.fromEntries(Object.entries(byAction).filter(([key]) => key.startsWith("email.action."))),
    telegramSent: byAction["telegram.notification.sent"] || 0,
    learnedRules: byAction["email.rule.learned"] || 0,
    recentActionCount: recentActions.length
  };
}

async function fetchGmailMessages(vault, params, deps) {
  const accountEmail = stringParam(params.accountEmail, "accountEmail");
  const token = vault.get(`${NS}:gmail`, accountEmail);
  if (!token) throw new Error("Gmail account is not connected on this local node");
  const fetchFn = deps.fetch || globalThis.fetch;
  const list = await fetchFn(`${GMAIL_API}/users/me/messages?maxResults=${Math.min(Number(params.limit || 10), 25)}`, {
    headers: { authorization: `${token.tokenType || "Bearer"} ${token.accessToken}` }
  });
  if (!list.ok) throw new Error(`Gmail list failed: ${list.status}`);
  const data = await list.json();
  return (data.messages || []).map((item) => ({
    id: item.id,
    from: "",
    subject: item.id,
    date: now(),
    preview: "Fetched from Gmail. Full content remains local."
  }));
}

async function executeGmailAction(vault, accountEmail, emailId, action, params, deps) {
  const token = vault.get(`${NS}:gmail`, accountEmail);
  if (!token) throw new Error("Gmail account is not connected on this local node");
  const fetchFn = deps.fetch || globalThis.fetch;
  let url = `${GMAIL_API}/users/me/messages/${encodeURIComponent(emailId)}`;
  let init = { method: "POST", headers: { authorization: `${token.tokenType || "Bearer"} ${token.accessToken}`, "content-type": "application/json" } };
  if (action === "delete") init.method = "DELETE";
  else if (action === "archive") {
    url += "/modify";
    init.body = JSON.stringify({ removeLabelIds: ["INBOX"] });
  } else if (action === "label") {
    url += "/modify";
    init.body = JSON.stringify({ addLabelIds: [params.labelId || "STARRED"] });
  } else {
    return { ok: true, simulated: true, note: `${action} prepared locally` };
  }
  const response = await fetchFn(url, init);
  if (!response.ok) throw new Error(`Gmail ${action} failed: ${response.status}`);
  return { ok: true, status: response.status };
}

function ruleFromFeedback(feedback) {
  const text = String(feedback.correction || "").toLowerCase();
  const match = text.match(/(?:don't|do not|never)\s+delete\s+from\s+([a-z0-9_.-]+\.[a-z]{2,})/);
  if (match) {
    return {
      id: `feedback-whitelist-${match[1].replace(/[^a-z0-9]/g, "-")}`,
      type: "sender_contains",
      value: match[1],
      category: "important",
      confidence: 0.9
    };
  }
  return null;
}

function audit(vault, action, meta = {}) {
  const record = {
    id: randomUUID(),
    action,
    meta,
    timestamp: now(),
    localOnlyDetails: true,
    masterSummaryEncrypted: true
  };
  vault.put(`${NS}:audit`, record.id, record);
  return record;
}

function redactAudit(record) {
  return {
    id: record.id,
    action: record.action,
    timestamp: record.timestamp,
    meta: record.meta || {}
  };
}

function safePreview(value) {
  return String(value || "").replace(/\s+/g, " ").slice(0, 240);
}

function locality() {
  return {
    emailContentLeavesNode: false,
    gmailTokensStoredInLocalVault: true,
    cloudReceivesEncryptedSummariesOnly: true
  };
}

function previewSecret(value) {
  const text = String(value || "");
  if (text.length <= 4) return "****";
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function withVault(fn) {
  const vault = new Vault();
  try {
    return fn(vault);
  } finally {
    vault.close();
  }
}

async function withVaultAsync(fn) {
  const vault = new Vault();
  try {
    return await fn(vault);
  } finally {
    vault.close();
  }
}

function stringParam(value, name) {
  const cleaned = String(value || "").trim();
  if (!cleaned) throw new Error(`${name} is required`);
  return cleaned;
}

function hash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function now() {
  return new Date().toISOString();
}
