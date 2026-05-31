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
      const tokenNumber = (key) => {
        return Number(key.replace("MINDVIDEO_TOKEN", "")) || Number.MAX_SAFE_INTEGER;
      };
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

async function callMindVideo(token, endpoint, options = {}) {
  const lang = process.env.MINDVIDEO_LANG || "zh-TW";

  const response = await fetch(`${API_BASE}/${endpoint.replace(/^\/+/, "")}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
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
  if (record.current_day !== undefined) parts.push(`??? ${record.current_day} 憭奈);
  if (record.total_credits !== undefined) parts.push(`?桀? ${record.total_credits} 暺);
  if (record.single_checkin_credits !== undefined) {
    parts.push(`瘥?舫? ${record.single_checkin_credits} 暺);
  }
  if (record.can_checkin_today !== undefined) {
    parts.push(record.can_checkin_today ? "隞予?舐偷?? : "隞予撌脩偷??);
  }
  return parts.join("嚗?) || JSON.stringify(record);
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
      console.error(`[${account.name}] 蝪賢憭望?嚗?{error.message}`);
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} account(s) failed.`);
  }
}

async function checkinAccount(account) {
  console.log(`[${account.name}] 瑼Ｘ蝪賢???..`);
  const before = await callMindVideo(account.token, "api/checkin/records");
  const record = before.data;
  console.log(`[${account.name}] ???${summarizeRecord(record)}`);

  if (!record?.can_checkin_today) {
    console.log(`[${account.name}] 銝?閬偷?堆?隞予撌脣??);
    return;
  }

  await callMindVideo(account.token, "api/checkin", { method: "POST" });
  const after = await callMindVideo(account.token, "api/checkin/records");
  console.log(`[${account.name}] 蝪賢??嚗?{summarizeRecord(after.data)}`);
}

main().catch((error) => {
  console.error(`蝪賢憭望?嚗?{error.message}`);
  process.exitCode = 1;
});
