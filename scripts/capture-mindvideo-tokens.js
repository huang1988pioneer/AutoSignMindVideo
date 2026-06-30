import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const DEFAULT_REPO = "huang1988pioneer/AutoSignMindVideo";
const DEFAULT_URL = "https://mindvideo.ai/zh/creative-studio/";

const DEFAULT_ACCOUNTS = [
  [1, "goldshoot0720"],
  [2, "abuhg17"],
  [3, "fengtuprinfo"],
  [4, "feng33feng35feng3"],
  [5, "chbondg2"],
  [6, "huang1988pioneer"],
  [7, "chbondg_outloook"],
  [8, "gaokaolevel3iptopscorer_outlook"],
  [9, "huang1988pioneer_outloook"],
  [10, "fengtuta_tuta"],
  [11, "fengfence_fence"],
  [12, "samafengtu"],
  [13, "fengtusama"],
  [14, "fengwithting0831"],
  [15, "fengwithfeng1127"],
  [16, "fengwithtu1127"],
  [17, "akaonda333"],
  [18, "fbussinesseng"],
  [19, "engdictatorf"],
  [20, "flottojackpoteng"],
  ...Array.from({ length: 13 }, (_, index) => {
    const number = index + 21;
    return [number, `account-${number}`];
  }),
];

function parseArgs() {
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
      options.accountNumbers = DEFAULT_ACCOUNTS.map(([number]) => number);
    }
  }

  if (!options.accountNumbers.every((number) => Number.isInteger(number) && number > 0)) {
    throw new Error("Account numbers must be positive integers.");
  }

  return options;
}

function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function printHelp() {
  console.log(`MindVideo token capture

Usage:
  npm run capture:tokens
  npm run capture:tokens -- --accounts 12,13,14
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

function accountList(numbers) {
  const labels = new Map(DEFAULT_ACCOUNTS);
  return numbers.map((number) => ({
    number,
    label: labels.get(number) || `account-${number}`,
    secretName: `MINDVIDEO_TOKEN${number}`,
  }));
}

async function captureAccountToken(chromium, account, options, rl) {
  console.log(`\n[${account.secretName}] ${account.label}`);
  console.log("Opening an isolated Playwright browser for this account.");

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

    console.log("Log in manually in the opened browser window.");
    await rl.question("After this account is logged in, press Enter here to capture its token...");

    const token = authorizationToken || (await waitForStoredToken(page, 60000));
    await context.close();
    context = null;

    if (!token) {
      throw new Error(`Could not find a token for ${account.secretName}.`);
    }

    console.log(`[${account.secretName}] Captured token ${maskToken(token)}.`);
    return token;
  } finally {
    if (context) await context.close();
    await browser.close();
  }
}

async function waitForStoredToken(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = await page.evaluate(findTokenInBrowserState);
    if (token) return token;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
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
        // Plain string values are fine; only JSON-like strings recurse.
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
  const options = parseArgs();
  const { chromium } = await loadPlaywright();
  const accounts = accountList(options.accountNumbers);
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
