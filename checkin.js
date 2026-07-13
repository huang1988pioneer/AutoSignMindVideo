import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const API_BASE = "https://api-app.mindvideo.ai";
const APP_VERSION = "1.0.8";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 1_200;
const VERIFY_POLLS = 4;
const VERIFY_DELAY_MS = 1_500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  const matrixSecretName = process.env.MINDVIDEO_SECRET_NAME?.trim();
  const matrixToken = process.env.MINDVIDEO_TOKEN?.trim();

  if (matrixSecretName || matrixToken) {
    if (!/^MINDVIDEO_TOKEN\d+$/.test(matrixSecretName || "")) {
      throw new Error("MINDVIDEO_SECRET_NAME must look like MINDVIDEO_TOKEN1.");
    }

    if (!matrixToken) {
      return [];
    }

    return [{ name: matrixSecretName, token: matrixToken }];
  }

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

function isTruthyFlag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function isFalsyFlag(value) {
  return value === false || value === 0 || value === "0" || value === "false";
}

function extractCheckinRecord(payload) {
  const root = payload?.data ?? payload;
  if (!root || typeof root !== "object") return null;

  if (
    "can_checkin_today" in root ||
    "total_credits" in root ||
    "current_day" in root ||
    "single_checkin_credits" in root
  ) {
    return root;
  }

  if (root.record && typeof root.record === "object") return root.record;
  if (root.checkin && typeof root.checkin === "object") return root.checkin;
  if (Array.isArray(root.records) && root.records[0] && typeof root.records[0] === "object") {
    return root.records[0];
  }
  if (Array.isArray(root) && root[0] && typeof root[0] === "object") {
    return root[0];
  }

  return root;
}

function getEligibility(record) {
  if (!record || typeof record !== "object") return "unknown";
  if (isTruthyFlag(record.can_checkin_today)) return "eligible";
  if (isFalsyFlag(record.can_checkin_today)) return "done";
  return "unknown";
}

function numberOrUndefined(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function summarizeRecord(record) {
  if (!record) return "No record data returned.";

  const parts = [];
  if (record.current_day !== undefined) parts.push(`streak ${record.current_day} day(s)`);
  if (record.total_credits !== undefined) parts.push(`credits ${record.total_credits}`);
  if (record.single_checkin_credits !== undefined) {
    parts.push(`daily reward ${record.single_checkin_credits}`);
  }

  const eligibility = getEligibility(record);
  if (eligibility === "eligible") parts.push("can check in today");
  else if (eligibility === "done") parts.push("already checked in today");
  else parts.push("check-in eligibility unknown");

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

function isRetryableError(error) {
  const message = String(error?.message || error || "");
  if (/abort|timeout|network|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return true;
  }
  if (/^(429|500|502|503|504)\b/.test(message)) return true;
  if (/\b(rate limit|too many requests|temporar|try again)\b/i.test(message)) return true;
  return false;
}

async function withRetry(label, fn, { attempts = MAX_ATTEMPTS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);
      if (!retryable || attempt >= attempts) break;

      const delay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
      console.warn(
        `[${label}] Attempt ${attempt}/${attempts} failed (${error.message}); retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }
  throw lastError;
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  const nextToken = payload?.data?.access_token || payload?.access_token || payload?.data?.token;
  if (!response.ok || !nextToken) {
    const message = payload?.message || response.statusText || "Token refresh failed";
    throw new Error(`${response.status} ${message}`);
  }

  account.token = nextToken;
  console.log(`[${account.name}] Refreshed expired token for this run.`);
  await persistMindVideoToken(account.name, nextToken);
}

async function persistMindVideoToken(secretName, token) {
  await Promise.allSettled([
    persistTokenToGitHubSecret(secretName, token),
    persistTokenToLocalEnv(secretName, token),
  ]);
}

async function persistTokenToGitHubSecret(secretName, token) {
  const ghToken = process.env.GH_SECRETS_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;

  if (!ghToken || !repo) {
    return;
  }

  await new Promise((resolve, reject) => {
    const child = spawn(
      "gh",
      ["secret", "set", secretName, "--repo", repo],
      {
        env: { ...process.env, GH_TOKEN: ghToken },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        console.log(`[${secretName}] Persisted refreshed token to GitHub secret.`);
        resolve();
        return;
      }

      reject(new Error(`gh secret set failed with exit code ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(token);
  });
}

async function persistTokenToLocalEnv(secretName, token) {
  if (process.env.GITHUB_ACTIONS === "true") return;

  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  try {
    const original = fs.readFileSync(envPath, "utf8");
    const pattern = new RegExp(`^${secretName}=.*$`, "m");
    let next;
    if (pattern.test(original)) {
      next = original.replace(pattern, `${secretName}=${token}`);
    } else {
      const suffix = original.endsWith("\n") || original.length === 0 ? "" : "\n";
      next = `${original}${suffix}${secretName}=${token}\n`;
    }
    if (next !== original) {
      fs.writeFileSync(envPath, next, "utf8");
      console.log(`[${secretName}] Persisted refreshed token to local .env.`);
    }
  } catch (error) {
    console.warn(`[${secretName}] Failed to persist token to local .env: ${error.message}`);
  }
}

async function callMindVideo(account, endpoint, options = {}) {
  const lang = process.env.MINDVIDEO_LANG || "zh-TW";
  const method = options.method || "GET";
  const headers = {
    Authorization: `Bearer ${account.token}`,
    "i-lang": lang,
    "i-version": APP_VERSION,
    Accept: "application/json",
    ...options.headers,
  };

  if (method !== "GET" && method !== "HEAD" && options.body !== undefined) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }

  const response = await fetch(`${API_BASE}/${endpoint.replace(/^\/+/, "")}`, {
    method,
    headers,
    body: options.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

  // MindVideo uses HTTP 200 with business codes. Success is code === 0.
  // 20001 = unauthorized (token dead).
  if (payload?.code === 20001 && options.refresh !== false) {
    await refreshMindVideoToken(account);
    return callMindVideo(account, endpoint, { ...options, refresh: false });
  }

  if (payload?.code !== undefined && payload.code !== 0) {
    throw new Error(`${payload.code} ${payload.message || "MindVideo API error"}`);
  }

  return payload;
}

async function fetchCheckinRecord(account) {
  const payload = await callMindVideo(account, "api/checkin/records");
  return extractCheckinRecord(payload);
}

async function logCreditStats(account) {
  try {
    const stats = await callMindVideo(account, "api/user/credits/stats");
    console.log(`[${account.name}] Credit stats: ${summarizeCreditStats(stats.data ?? stats)}`);
    return stats.data ?? stats;
  } catch (error) {
    console.warn(`[${account.name}] Credit stats unavailable: ${error.message}`);
    return null;
  }
}

function creditsIncreased(before, after) {
  const beforeTotal = numberOrUndefined(before?.total_credits);
  const afterTotal = numberOrUndefined(after?.total_credits);
  if (beforeTotal === undefined || afterTotal === undefined) return null;
  return afterTotal > beforeTotal;
}

function expectedReward(before) {
  return numberOrUndefined(before?.single_checkin_credits) ?? 0;
}

async function verifyCheckinSettled(account, before) {
  let last = null;

  for (let poll = 1; poll <= VERIFY_POLLS; poll += 1) {
    last = await fetchCheckinRecord(account);
    const eligibility = getEligibility(last);

    if (eligibility === "done") {
      const gained = creditsIncreased(before, last);
      if (gained === false && expectedReward(before) > 0 && poll < VERIFY_POLLS) {
        // Status flipped but credits lag; keep polling a bit.
        await sleep(VERIFY_DELAY_MS);
        continue;
      }
      return { record: last, settled: true, creditsGained: gained };
    }

    if (poll < VERIFY_POLLS) {
      await sleep(VERIFY_DELAY_MS);
    }
  }

  return {
    record: last,
    settled: getEligibility(last) === "done",
    creditsGained: creditsIncreased(before, last),
  };
}

async function performCheckin(account) {
  // Official web client posts with no body; keep that shape.
  return callMindVideo(account, "api/checkin", {
    method: "POST",
  });
}

/**
 * @returns {Promise<{
 *   status: 'checked_in' | 'already_done' | 'failed',
 *   message: string,
 *   before?: object | null,
 *   after?: object | null,
 *   creditsDelta?: number | null
 * }>}
 */
async function checkinAccount(account) {
  console.log(`[${account.name}] Checking sign-in status...`);

  const before = await withRetry(account.name, () => fetchCheckinRecord(account));
  console.log(`[${account.name}] Status: ${summarizeRecord(before)}`);
  await logCreditStats(account);

  const eligibility = getEligibility(before);

  if (eligibility === "done") {
    console.log(`[${account.name}] No check-in needed: already completed today.`);
    return {
      status: "already_done",
      message: "already checked in today",
      before,
      after: before,
      creditsDelta: 0,
    };
  }

  if (eligibility === "unknown") {
    console.warn(
      `[${account.name}] Eligibility flag missing/unknown; attempting check-in to avoid missing rewards.`
    );
  }

  let checkinPayload;
  try {
    checkinPayload = await withRetry(account.name, () => performCheckin(account));
  } catch (error) {
    // If the API rejects because the account already checked in, treat as success.
    if (/already|checked in|has check|重复|已签|已簽/i.test(error.message)) {
      const after = await fetchCheckinRecord(account).catch(() => before);
      console.log(`[${account.name}] API reports already checked in: ${summarizeRecord(after)}`);
      return {
        status: "already_done",
        message: error.message,
        before,
        after,
        creditsDelta: 0,
      };
    }
    throw error;
  }

  if (checkinPayload?.data) {
    console.log(
      `[${account.name}] Check-in API response data: ${JSON.stringify(checkinPayload.data)}`
    );
  }

  const verification = await withRetry(account.name, () => verifyCheckinSettled(account, before));
  const after = verification.record;
  console.log(`[${account.name}] After check-in: ${summarizeRecord(after)}`);
  await logCreditStats(account);

  const beforeCredits = numberOrUndefined(before?.total_credits);
  const afterCredits = numberOrUndefined(after?.total_credits);
  const creditsDelta =
    beforeCredits !== undefined && afterCredits !== undefined
      ? afterCredits - beforeCredits
      : null;

  if (!verification.settled) {
    throw new Error(
      `Check-in did not settle: still eligible after POST (${summarizeRecord(after)})`
    );
  }

  // When we knew the account was eligible, a missing credit increase is a real failure.
  // When eligibility was unknown, the account may already have been checked in earlier;
  // prefer reporting already_done over a hard fail.
  if (verification.creditsGained === false && expectedReward(before) > 0) {
    const detail = `credits did not increase (before ${beforeCredits}, after ${afterCredits}, expected +${expectedReward(before)})`;
    if (eligibility === "eligible") {
      throw new Error(`Check-in marked done but ${detail}`);
    }
    console.warn(`[${account.name}] Settled without credit gain after unknown eligibility: ${detail}`);
    return {
      status: "already_done",
      message: detail,
      before,
      after,
      creditsDelta: creditsDelta ?? 0,
    };
  }

  if (creditsDelta !== null && creditsDelta > 0) {
    console.log(`[${account.name}] Credits gained: +${creditsDelta}`);
  } else {
    console.log(
      `[${account.name}] Check-in completed${
        expectedReward(before) ? ` (expected daily reward ${expectedReward(before)})` : ""
      }.`
    );
  }

  return {
    status: "checked_in",
    message: "check-in successful",
    before,
    after,
    creditsDelta,
  };
}

function accountNumberFromName(name) {
  const match = String(name || "").match(/MINDVIDEO_TOKEN(\d+)/i);
  if (match) return Number(match[1]);
  const fromEnv = Number(process.env.MINDVIDEO_ACCOUNT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : null;
}

function normalizeResultRow(item) {
  const afterCredits = numberOrUndefined(item.after?.total_credits);
  const beforeCredits = numberOrUndefined(item.before?.total_credits);
  const streak = numberOrUndefined(item.after?.current_day ?? item.before?.current_day);
  const dailyReward = numberOrUndefined(
    item.after?.single_checkin_credits ?? item.before?.single_checkin_credits
  );

  return {
    account: accountNumberFromName(item.name),
    name: item.name,
    status: item.status,
    message: item.message || "",
    creditsDelta:
      item.creditsDelta === undefined
        ? null
        : item.creditsDelta,
    totalCredits: afterCredits ?? beforeCredits ?? null,
    streak: streak ?? null,
    dailyReward: dailyReward ?? null,
    finishedAt: new Date().toISOString(),
    runId: process.env.GITHUB_RUN_ID || null,
    job: process.env.GITHUB_JOB || null,
  };
}

function writeResultsArtifact(results) {
  const outDir = process.env.MINDVIDEO_RESULT_DIR || path.join(process.cwd(), "artifacts");
  fs.mkdirSync(outDir, { recursive: true });

  const rows = results.map(normalizeResultRow);
  const singlePath = path.join(outDir, "checkin-result.json");
  const multiPath = path.join(outDir, "checkin-results.json");

  if (rows.length === 1) {
    fs.writeFileSync(singlePath, `${JSON.stringify(rows[0], null, 2)}\n`, "utf8");
  } else {
    fs.writeFileSync(multiPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    for (const row of rows) {
      const suffix = row.account ?? row.name;
      fs.writeFileSync(
        path.join(outDir, `checkin-result-${suffix}.json`),
        `${JSON.stringify(row, null, 2)}\n`,
        "utf8"
      );
    }
  }

  console.log(`[result] Wrote ${rows.length} result row(s) under ${outDir}`);
  return rows;
}

function printSummary(results) {
  const checkedIn = results.filter((item) => item.status === "checked_in");
  const alreadyDone = results.filter((item) => item.status === "already_done");
  const failed = results.filter((item) => item.status === "failed");
  const skipped = results.filter((item) => item.status === "skipped");

  console.log("\n========== Check-in summary ==========");
  console.log(
    `Total: ${results.length} | checked in: ${checkedIn.length} | already done: ${alreadyDone.length} | skipped: ${skipped.length} | failed: ${failed.length}`
  );

  for (const item of results) {
    const delta =
      item.creditsDelta === null || item.creditsDelta === undefined
        ? "n/a"
        : `${item.creditsDelta >= 0 ? "+" : ""}${item.creditsDelta}`;
    const afterCredits = numberOrUndefined(item.after?.total_credits);
    const creditsText = afterCredits === undefined ? "credits n/a" : `credits ${afterCredits}`;
    console.log(
      `- ${item.name}: ${item.status} | delta ${delta} | ${creditsText} | ${item.message}`
    );
  }
  console.log("======================================\n");

  // Matrix jobs skip Job Summary on purpose — the daily-summary job writes one
  // LitMedia-style combined report for the whole workflow run.
  if (process.env.GITHUB_STEP_SUMMARY && !process.env.MINDVIDEO_SECRET_NAME) {
    const lines = [
      "## MindVideo check-in summary",
      "",
      `| Account | Status | Credit delta | Total credits | Detail |`,
      `| --- | --- | ---: | ---: | --- |`,
      ...results.map((item) => {
        const delta =
          item.creditsDelta === null || item.creditsDelta === undefined
            ? "n/a"
            : String(item.creditsDelta);
        const afterCredits = numberOrUndefined(item.after?.total_credits);
        return `| ${item.name} | ${item.status} | ${delta} | ${
          afterCredits === undefined ? "n/a" : afterCredits
        } | ${String(item.message || "").replace(/\|/g, "/")} |`;
      }),
      "",
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, "utf8");
  }
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env"));

  // Optional stagger for matrix jobs to reduce thundering-herd 429s.
  const staggerMs = Number(process.env.MINDVIDEO_STAGGER_MS || 0);
  if (Number.isFinite(staggerMs) && staggerMs > 0) {
    console.log(`Staggering start by ${staggerMs}ms...`);
    await sleep(staggerMs);
  }

  const tokens = getTokens();
  console.log(
    `[${new Date().toISOString()}] Checking MindVideo sign-in status for ${tokens.length} account(s)...`
  );

  if (tokens.length === 0) {
    const name = process.env.MINDVIDEO_SECRET_NAME || "MINDVIDEO_TOKEN?";
    console.log("No token configured for this job; skipping.");
    const results = [
      {
        name,
        status: "skipped",
        message: "token not configured",
        before: null,
        after: null,
        creditsDelta: null,
      },
    ];
    writeResultsArtifact(results);
    printSummary(results);
    return;
  }

  const results = [];
  let failures = 0;

  for (const account of tokens) {
    try {
      const result = await checkinAccount(account);
      results.push({ name: account.name, ...result });
    } catch (error) {
      failures += 1;
      console.error(`[${account.name}] Check-in failed: ${error.message}`);
      results.push({
        name: account.name,
        status: "failed",
        message: error.message,
        before: null,
        after: null,
        creditsDelta: null,
      });
    }

    // Small pause between local multi-account runs.
    if (tokens.length > 1) {
      await sleep(500 + Math.floor(Math.random() * 500));
    }
  }

  writeResultsArtifact(results);
  printSummary(results);

  if (failures > 0) {
    throw new Error(`${failures} account(s) failed.`);
  }
}

main().catch((error) => {
  console.error(`Check-in failed: ${error.message}`);
  process.exitCode = 1;
});
