import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadAccountConfig } from "./account-config.mjs";

const DEFAULT_REPO = "huang1988pioneer/AutoSignMindVideo";
/** Open MindVideo sign-in page first so Google OAuth is one click away. */
const DEFAULT_URL = "https://www.mindvideo.ai/auth/signin/";
const API_BASE = "https://api-app.mindvideo.ai";
const APP_VERSION = "1.0.8";
const MIN_TOKEN_LENGTH = 80;
const VERIFY_ENDPOINT = "/api/checkin/records";
/** After API confirms login, hold ≥5s while still logged in before capture/close. */
const LOGIN_HOLD_MS = 5_000;
const POLL_MS = 500;

function parseArgs(config) {
  const args = process.argv.slice(2);
  const options = {
    accountNumbers: null,
    updateSecrets: false,
    outputFile: ".env.captured",
    repo: DEFAULT_REPO,
    url: DEFAULT_URL,
  };
  let startNumber = null;
  let endNumber = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--accounts") {
      options.accountNumbers = args[++index].split(",").map((value) => Number(value.trim()));
    } else if (arg === "--start") {
      startNumber = Number(args[++index]);
    } else if (arg === "--end") {
      endNumber = Number(args[++index]);
    } else if (arg === "--update-secrets") {
      options.updateSecrets = true;
    } else if (arg === "--output") {
      options.outputFile = args[++index];
    } else if (arg === "--repo") {
      options.repo = args[++index];
    } else if (arg === "--url") {
      options.url = args[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.accountNumbers) {
    if (startNumber !== null) {
      options.accountNumbers = range(startNumber, endNumber ?? startNumber);
    } else {
      options.accountNumbers = config.accounts.map(({ number }) => number);
    }
  }

  if (!options.accountNumbers.every((number) => Number.isInteger(number) && number > 0)) {
    throw new Error("Account numbers must be positive integers.");
  }

  return options;
}

function range(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    throw new Error("--start/--end must be an ascending integer range.");
  }
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function printHelp() {
  console.log(`MindVideo token capture

Usage:
  npm run capture:tokens
  npm run capture:tokens -- --accounts 1,2,3
  npm run capture:tokens -- --start 21 --end 33 --update-secrets

Options:
  --accounts 1,2       Capture only listed token numbers.
  --start N --end M    Capture a numeric range.
  --update-secrets     Write captured tokens to GitHub Actions secrets.
  --output FILE        Write captured tokens to a local dotenv file. Default: .env.captured
  --repo OWNER/REPO    GitHub repo for --update-secrets. Default: ${DEFAULT_REPO}
  --url URL            MindVideo page to open. Default: ${DEFAULT_URL}
`);
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright is not installed. Run: npm install");
  }
}

function accountList(numbers, config) {
  return numbers.map((number) => {
    const account = config.accounts.find((item) => item.number === number);
    if (!account) {
      throw new Error(`Account #${number} is disabled or missing in accounts.json.`);
    }
    return {
      ...account,
      secretName: `MINDVIDEO_TOKEN${number}`,
    };
  });
}

function isMindVideoApiUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "api-app.mindvideo.ai" || host.endsWith(".mindvideo.ai");
  } catch {
    return false;
  }
}

/** Runs in the browser: prefer user.token and confirm a logged-in user profile exists. */
function inspectLoginState() {
  const MIN_LEN = 80;

  const clean = (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim().replace(/^Bearer\s+/i, "");
    return trimmed.length >= MIN_LEN ? trimmed : null;
  };

  const scoreToken = (value) => {
    let score = value.length;
    if (value.split(".").length === 3) score += 1000;
    if (/^[A-Za-z0-9._-]+$/.test(value)) score += 100;
    return score;
  };

  const storageBags = [localStorage, sessionStorage];
  let preferredToken = null;
  let hasUserProfile = false;
  const candidates = [];

  const visit = (value) => {
    if (!value) return;
    if (typeof value === "string") {
      const token = clean(value);
      if (token) candidates.push(token);
      try {
        visit(JSON.parse(value));
      } catch {
        // plain string
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === "object") {
      if (
        value.email ||
        value.user_id ||
        value.userId ||
        value.nickname ||
        value.username ||
        value.avatar ||
        value.id
      ) {
        hasUserProfile = true;
      }
      for (const [key, child] of Object.entries(value)) {
        const keyLower = String(key).toLowerCase();
        if (keyLower === "token" || keyLower === "access_token" || keyLower === "authorization") {
          const token = clean(child);
          if (token) candidates.push(token);
        }
        visit(child);
      }
    }
  };

  for (const storage of storageBags) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;
      const raw = storage.getItem(key);
      if (key === "user.token" || key.endsWith(".token") || /user\.?token/i.test(key)) {
        preferredToken = clean(raw) || preferredToken;
      }
      if (/^user(\.|$)|profile|auth|account/i.test(key)) {
        visit(raw);
        if (raw && raw.length > 2) {
          hasUserProfile = hasUserProfile || /email|nickname|user_id|username/i.test(raw);
        }
      } else {
        visit(raw);
      }
    }
  }

  candidates.sort((a, b) => scoreToken(b) - scoreToken(a));
  const token = preferredToken || candidates[0] || null;
  const loggedIn = Boolean(token && (preferredToken || hasUserProfile));

  return {
    token,
    preferredToken,
    hasUserProfile,
    loggedIn,
    source: preferredToken ? "user.token" : token ? "storage" : null,
  };
}

async function verifyTokenWithApi(token) {
  const response = await fetch(`${API_BASE}${VERIFY_ENDPOINT}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "i-lang": "zh-TW",
      "i-version": APP_VERSION,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (response.status === 401 || payload?.code === 20001) {
    return { ok: false, reason: payload?.message || `HTTP ${response.status} unauthorized` };
  }
  if (!response.ok) {
    return { ok: false, reason: payload?.message || `HTTP ${response.status}` };
  }
  if (payload?.code !== undefined && payload.code !== 0) {
    return { ok: false, reason: `${payload.code} ${payload.message || "MindVideo API error"}` };
  }
  return { ok: true, payload };
}

async function launchBrowser(chromium) {
  const attempts = [
    { channel: "chrome", headless: false },
    { channel: "msedge", headless: false },
    { headless: false },
  ];
  let lastError;
  for (const opts of attempts) {
    try {
      const browser = await chromium.launch(opts);
      console.log(`Launched browser: ${opts.channel || "chromium"}`);
      return browser;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Could not launch a browser for Google login.");
}

/** Navigate to sign-in and click Google login when present. */
async function openGoogleLogin(page, startUrl) {
  const signInUrls = [
    startUrl,
    "https://www.mindvideo.ai/auth/signin/",
    "https://www.mindvideo.ai/zh/auth/signin/",
    "https://mindvideo.ai/auth/signin/",
  ].filter((value, index, all) => value && all.indexOf(value) === index);

  for (const url of signInUrls) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch {
      continue;
    }
    await page.waitForTimeout(1500);

    const clicked = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const looksLikeGoogle = (text) =>
        /google|使用\s*google|用\s*google|login\s*with\s*google|continue\s*with\s*google|sign\s*in\s*with\s*google/i.test(
          text || ""
        );
      for (const el of document.querySelectorAll(
        'a, button, [role="button"], div[class*="google" i], span[class*="google" i]'
      )) {
        const text = `${el.innerText || el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("href") || ""}`;
        if (looksLikeGoogle(text) && isVisible(el)) {
          el.click();
          return true;
        }
      }
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || "";
        if (
          /accounts\.google\.com|google.*oauth|\/auth\/.*google|provider=google/i.test(href) &&
          isVisible(a)
        ) {
          a.click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      console.log("Clicked MindVideo「Login with Google」.");
      return;
    }
  }
  console.log("Could not auto-click Google login; please click「Login with Google」manually.");
}

async function captureAccountToken(chromium, account, options, rl) {
  console.log(`\n[${account.secretName}] ${account.label}`);
  console.log("Opening browser for Google login (this account uses Google).");

  const browser = await launchBrowser(chromium);
  let context;

  try {
    context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      locale: "zh-TW",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });

    let networkToken = null;
    context.on("request", (request) => {
      if (!isMindVideoApiUrl(request.url())) return;
      const authorization = request.headers().authorization || "";
      if (!authorization.toLowerCase().startsWith("bearer ")) return;
      const token = authorization.slice("bearer ".length).trim();
      if (token.length >= MIN_TOKEN_LENGTH) networkToken = token;
    });

    const page = await context.newPage();
    await openGoogleLogin(page, options.url);

    console.log("Complete Google sign-in in the opened browser window.");
    console.log("Only press Enter after Google login finishes (profile / studio visible).");
    console.log(
      `After Enter: API verify → keep logged in ≥${LOGIN_HOLD_MS / 1000}s → capture token → close.`
    );
    await rl.question(
      "After Google login succeeds, press Enter to verify and capture its token..."
    );

    const deadline = Date.now() + 90_000;
    let lastReason = "";
    /** @type {{ token: string, holdStartedAt: number } | null} */
    let hold = null;

    while (Date.now() < deadline) {
      let state = {
        token: null,
        loggedIn: false,
        preferredToken: null,
        hasUserProfile: false,
        source: null,
      };
      try {
        state = await page.evaluate(inspectLoginState);
      } catch {
        // navigation mid-evaluate
      }

      const candidate =
        state.preferredToken ||
        (state.loggedIn ? state.token : null) ||
        (networkToken && state.hasUserProfile ? networkToken : null) ||
        (networkToken && state.token ? networkToken : null);

      if (!candidate) {
        if (hold) {
          console.log(`[${account.secretName}] Login dropped during 5s hold; restarting…`);
          hold = null;
        }
        console.log(
          `[${account.secretName}] Login not confirmed yet (need user.token / profile). Waiting…`
        );
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }

      // Token rotation while logged in is normal — keep the hold timer.
      if (hold && hold.token !== candidate) {
        console.log(
          `[${account.secretName}] Token refreshed during hold; timer continues with latest token.`
        );
        hold.token = candidate;
      }

      if (!hold) {
        console.log(`[${account.secretName}] Verifying token with MindVideo API…`);
        const verification = await verifyTokenWithApi(candidate);
        if (!verification.ok) {
          lastReason = verification.reason;
          console.log(
            `[${account.secretName}] Token rejected (${verification.reason}). Finish login, then wait…`
          );
          if (networkToken === candidate) networkToken = null;
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          continue;
        }
        hold = { token: candidate, holdStartedAt: Date.now() };
        console.log(
          `[${account.secretName}] API OK. Keeping browser open ≥${LOGIN_HOLD_MS / 1000}s while logged in…`
        );
      }

      const heldMs = Date.now() - hold.holdStartedAt;
      const heldSec = (heldMs / 1000).toFixed(1);
      if (heldMs < LOGIN_HOLD_MS) {
        console.log(
          `[${account.secretName}] Holding login ${heldSec}s / ${LOGIN_HOLD_MS / 1000}s before close…`
        );
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }

      let stillIn = null;
      try {
        stillIn = await page.evaluate(inspectLoginState);
      } catch {
        stillIn = null;
      }
      const stillToken =
        stillIn?.preferredToken || stillIn?.token || candidate || hold.token || null;
      // Only restart if the token vanished — not when it merely rotated.
      if (!stillToken || stillToken.length < MIN_TOKEN_LENGTH) {
        console.log(`[${account.secretName}] Login no longer stable after 5s hold (token missing); restarting…`);
        hold = null;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }

      const finalCheck = await verifyTokenWithApi(stillToken);
      if (!finalCheck.ok) {
        lastReason = finalCheck.reason;
        console.log(
          `[${account.secretName}] Token failed final check (${finalCheck.reason}); restarting…`
        );
        if (networkToken === stillToken) networkToken = null;
        hold = null;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }

      // Capture token while browser is still open; close only after.
      const tokenToReturn = stillToken.trim();
      console.log(
        `[${account.secretName}] Token captured (browser still open): ${maskToken(tokenToReturn)}.`
      );
      console.log(`[${account.secretName}] Closing browser after successful token capture.`);
      await context.close();
      context = null;
      return tokenToReturn;
    }

    throw new Error(
      `Could not verify a logged-in token held ≥5s for ${account.secretName}` +
        (lastReason ? ` (last API error: ${lastReason})` : "") +
        ". Make sure the account is fully signed in."
    );
  } finally {
    if (context) await context.close();
    await browser.close();
  }
}

function maskToken(token) {
  if (token.length <= 16) return "***";
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}

async function updateGitHubSecret(repo, secretName, token) {
  await new Promise((resolve, reject) => {
    const child = spawn("gh", ["secret", "set", secretName, "--repo", repo], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`gh secret set ${secretName} failed: ${stderr.trim()}`));
    });
    child.stdin.end(token);
  });
}

function writeCapturedEnv(outputFile, captured) {
  const lines = [
    "# Captured MindVideo tokens.",
    "# Do not commit this file.",
    ...captured.flatMap(({ account, token }) => [
      `# ${account.label}`,
      `${account.secretName}=${token}`,
      "",
    ]),
  ];
  fs.writeFileSync(outputFile, lines.join("\n"), "utf8");
}

async function main() {
  const config = loadAccountConfig();
  const options = parseArgs(config);
  const { chromium } = await loadPlaywright();
  const accounts = accountList(options.accountNumbers, config);
  const captured = [];
  const rl = readline.createInterface({ input, output });

  try {
    for (const account of accounts) {
      const token = await captureAccountToken(chromium, account, options, rl);
      captured.push({ account, token });

      if (options.updateSecrets) {
        await updateGitHubSecret(options.repo, account.secretName, token);
        console.log(`[${account.secretName}] Updated GitHub secret.`);
      }
    }
  } finally {
    rl.close();
  }

  if (captured.length > 0) {
    writeCapturedEnv(options.outputFile, captured);
    console.log(`\nWrote ${captured.length} token(s) to ${options.outputFile}.`);
  }
}

main().catch((error) => {
  console.error(`Token capture failed: ${error.message}`);
  process.exitCode = 1;
});
