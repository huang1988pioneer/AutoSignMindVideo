/**
 * GUI-friendly single-account MindVideo token capture.
 * Opens a headed browser, polls for a Bearer token, writes it to --output, then exits.
 *
 * Usage:
 *   node scripts/capture-token-gui.mjs --account 1 --output logs/token-01.txt
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_URL = "https://mindvideo.ai/zh/creative-studio/";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    account: 1,
    output: null,
    url: DEFAULT_URL,
    timeoutMs: 10 * 60 * 1000,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--account") options.account = Number(args[++i]);
    else if (arg === "--output") options.output = args[++i];
    else if (arg === "--url") options.url = args[++i];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(args[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/capture-token-gui.mjs --account N --output FILE`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.account) || options.account < 1) {
    throw new Error("--account must be a positive integer");
  }
  if (!options.output) {
    options.output = path.join("logs", `mindvideo-token-${String(options.account).padStart(2, "0")}.txt`);
  }
  return options;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright is not installed. Run: npm install");
  }
}

function findTokenInBrowserState() {
  const candidates = [];
  const addCandidate = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length < 80) return;
    candidates.push(trimmed.replace(/^Bearer\s+/i, ""));
  };

  const visit = (value) => {
    if (!value) return;
    if (typeof value === "string") {
      addCandidate(value);
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
      for (const [key, child] of Object.entries(value)) {
        if (/token|authorization|access/i.test(key)) addCandidate(child);
        visit(child);
      }
    }
  };

  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      visit(storage.getItem(key));
    }
  }

  candidates.sort((a, b) => scoreToken(b) - scoreToken(a));
  return candidates[0] || null;

  function scoreToken(value) {
    let score = value.length;
    if (value.split(".").length === 3) score += 1000;
    if (/^[A-Za-z0-9._-]+$/.test(value)) score += 100;
    return score;
  }
}

function maskToken(token) {
  if (token.length <= 16) return "***";
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}

async function main() {
  const options = parseArgs();
  const { chromium } = await loadPlaywright();
  const secretName = `MINDVIDEO_TOKEN${options.account}`;

  console.log(`[${secretName}] Opening browser. Log in, then wait for automatic capture…`);

  const browser = await chromium.launch({ headless: false });
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      locale: "zh-TW",
    });

    let authorizationToken = null;
    context.on("request", (request) => {
      const authorization = request.headers().authorization || "";
      if (authorization.toLowerCase().startsWith("bearer ")) {
        authorizationToken = authorization.slice("bearer ".length).trim();
      }
    });

    const page = await context.newPage();
    await page.goto(options.url, { waitUntil: "domcontentloaded" });

    const deadline = Date.now() + options.timeoutMs;
    let token = null;
    while (Date.now() < deadline) {
      token = authorizationToken;
      if (!token) {
        try {
          token = await page.evaluate(findTokenInBrowserState);
        } catch {
          // page may navigate mid-evaluate
        }
      }
      if (token && token.length >= 80) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!token) {
      throw new Error(`Timed out waiting for token (${Math.round(options.timeoutMs / 1000)}s).`);
    }

    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${token.trim()}\n`, "utf8");
    console.log(`[${secretName}] Captured ${maskToken(token)} → ${outputPath}`);
  } finally {
    if (context) await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`Token capture failed: ${error.message}`);
  process.exitCode = 1;
});
