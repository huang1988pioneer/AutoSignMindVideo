import fs from "node:fs";
import path from "node:path";

const API_BASE = "https://api-app.mindvideo.ai";
const APP_VERSION = "1.0.8";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) process.env[key] = value;
  }
}

function getTokens() {
  const tokens = Object.entries(process.env)
    .filter(([key, value]) => /^MINDVIDEO_TOKEN\d+$/.test(key) && value?.trim())
    .sort(([a], [b]) => {
      const tokenNumber = (key) =>
        Number(key.replace("MINDVIDEO_TOKEN", "")) || Number.MAX_SAFE_INTEGER;
      return tokenNumber(a) - tokenNumber(b);
    })
    .map(([key, value]) => ({ name: key, token: value.trim() }));

  if (tokens.length === 0) {
    throw new Error(
      "Missing MINDVIDEO_TOKEN1. Copy .env.example to .env and paste your MindVideo login token."
    );
  }

  return tokens;
}

async function refreshMindVideoToken(account) {
  const lang = process.env.MINDVIDEO_LANG || "zh-TW";

  const response = await fetch(`${API_BASE}/api/refresh`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.token}`,
      "i-lang": lang,
      "i-version": APP_VERSION,
      Accept: "application/json",
    },
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  const nextToken = payload?.data?.access_token || payload?.access_token;
  if (!response.ok || !nextToken) {
    const message = payload?.message || response.statusText || "Token refresh failed";
    throw new Error(`${response.status} ${message}`);
  }

  account.token = nextToken;
  console.log(`[${account.name}] Refreshed expired token for this run.`);
}

async function callMindVideo(account, endpoint, options = {}) {
  const lang = process.env.MINDVIDEO_LANG || "zh-TW";

  const response = await fetch(`${API_BASE}/${endpoint.replace(/^\/+/, "")}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${account.token}`,
      "i-lang": lang,
      "i-version": APP_VERSION,
      Accept: "application/json",
      ...options.headers,
    },
    body: options.body,
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    if (response.status === 401 && options.refresh !== false) {
      await refreshMindVideoToken(account);
      return callMindVideo(account, endpoint, { ...options, refresh: false });
    }

    const message = payload?.message || response.statusText || "Request failed";
    throw new Error(`${response.status} ${message}`);
  }

  if (payload?.code !== undefined && payload.code !== 0) {
    throw new Error(`${payload.code} ${payload.message || "MindVideo API error"}`);
  }

  return payload;
}

function summarizeRecord(record) {
  if (!record) return "No record data returned.";

  const parts = [];
  if (record.current_day !== undefined) parts.push(`streak ${record.current_day} day(s)`);
  if (record.total_credits !== undefined) parts.push(`credits ${record.total_credits}`);
  if (record.single_checkin_credits !== undefined) {
    parts.push(`daily reward ${record.single_checkin_credits}`);
  }
  if (record.can_checkin_today !== undefined) {
    parts.push(record.can_checkin_today ? "can check in today" : "already checked in today");
  }

  return parts.join(", ") || JSON.stringify(record);
}

function summarizeCreditStats(stats) {
  if (!stats || typeof stats !== "object") return "No credit stats returned.";

  const interesting = {};
  const visit = (value, pathParts = []) => {
    if (value === null || value === undefined) return;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      const key = pathParts.join(".");
      if (/credit|point|score|balance|quota|limit|used|free|total|remain|subscription/i.test(key)) {
        interesting[key] = value;
      }
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 5).forEach((item, index) => visit(item, [...pathParts, String(index)]));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, [...pathParts, key]);
    }
  };

  visit(stats);
  return Object.keys(interesting).length ? JSON.stringify(interesting) : JSON.stringify(stats);
}

async function logCreditStats(account) {
  try {
    const stats = await callMindVideo(account, "api/user/credits/stats");
    console.log(`[${account.name}] Credit stats: ${summarizeCreditStats(stats.data ?? stats)}`);
  } catch (error) {
    console.warn(`[${account.name}] Credit stats unavailable: ${error.message}`);
  }
}

async function checkinAccount(account) {
  console.log(`[${account.name}] Checking sign-in status...`);
  const before = await callMindVideo(account, "api/checkin/records");
  const record = before.data;
  console.log(`[${account.name}] Status: ${summarizeRecord(record)}`);
  await logCreditStats(account);

  if (!record?.can_checkin_today) {
    console.log(`[${account.name}] No check-in needed: already completed today.`);
    return;
  }

  await callMindVideo(account, "api/checkin", { method: "POST" });
  const after = await callMindVideo(account, "api/checkin/records");
  console.log(`[${account.name}] Check-in successful: ${summarizeRecord(after.data)}`);
  await logCreditStats(account);
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env"));

  const tokens = getTokens();
  console.log(
    `[${new Date().toISOString()}] Checking MindVideo sign-in status for ${tokens.length} account(s)...`
  );

  let failures = 0;
  for (const account of tokens) {
    try {
      await checkinAccount(account);
    } catch (error) {
      failures += 1;
      console.error(`[${account.name}] Check-in failed: ${error.message}`);
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} account(s) failed.`);
  }
}

main().catch((error) => {
  console.error(`Check-in failed: ${error.message}`);
  process.exitCode = 1;
});
