/**
 * GUI-friendly single-account MindVideo token capture.
 *
 * Browsers:
 *   - chrome (default): real Chrome/Edge via CDP (--user-data-dir dedicated folder)
 *   - firefox: Playwright firefox.launchPersistentContext (profile folder)
 *
 * Order: Google login → hold ≥5s → capture token → close browser
 *
 * Usage:
 *   node scripts/capture-token-gui.mjs --account 1 --output logs/mindvideo-token-01-alias.txt
 *   node scripts/capture-token-gui.mjs --account 1 --browser firefox --executable-path "C:\\...\\firefox.exe"
 *
 * Default --output (when omitted) is logs/mindvideo-token-NN[-alias].txt
 * using the account label from accounts.json when available.
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { getAccountDefinition, getSecretName, loadAccountConfig } from "./account-config.mjs";

/** Open MindVideo sign-in page first so Google OAuth is one click away. */
const DEFAULT_URL = "https://www.mindvideo.ai/auth/signin/";
const API_BASE = "https://api-app.mindvideo.ai";
const APP_VERSION = "1.0.8";
const MIN_TOKEN_LENGTH = 80;
const VERIFY_ENDPOINT = "/api/checkin/records";
/**
 * After API confirms login, keep the browser open and re-check that the
 * session stays logged in for at least this long before auto-closing.
 */
const LOGIN_HOLD_MS = 5_000;
const POLL_MS = 500;
/** Isolated profile used only when an account has no chrome-profiles.json mapping. */
const ISOLATED_PROFILE_DIR = path.join(process.cwd(), ".browser-profiles", "mindvideo-google");
const CHROME_PROFILES_FILE = path.join(process.cwd(), "chrome-profiles.json");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    account: 1,
    output: null,
    url: DEFAULT_URL,
    timeoutMs: 10 * 60 * 1000,
    browser: null,
    profileDirectory: null,
    userDataDir: null,
    executablePath: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--account") options.account = Number(args[++i]);
    else if (arg === "--output") options.output = args[++i];
    else if (arg === "--url") options.url = args[++i];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(args[++i]);
    else if (arg === "--browser") options.browser = String(args[++i] || "").toLowerCase();
    else if (arg === "--profile-directory") options.profileDirectory = args[++i];
    else if (arg === "--user-data-dir") options.userDataDir = args[++i];
    else if (arg === "--executable-path") options.executablePath = args[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/capture-token-gui.mjs --account N --output FILE
  --browser chrome|firefox   Browser engine (default: infer from executable / chrome)
  --profile-directory NAME   Chrome note / profile label (not used for CDP user-data)
  --user-data-dir PATH       Chrome CDP user-data-dir OR Firefox profile directory
  --executable-path PATH     chrome.exe / msedge.exe / firefox.exe`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.account) || options.account < 1) {
    throw new Error("--account must be a positive integer");
  }

  const accountConfig = loadAccountConfig();
  const account = getAccountDefinition(accountConfig, options.account);
  if (!account) {
    throw new Error(`Account #${options.account} is disabled or missing in accounts.json.`);
  }
  options.accountLabel = account.label;

  // Merge account mapping from chrome-profiles.json (CLI flags win).
  const mapped = loadChromeProfileMapping(options.account);
  if (mapped) {
    if (!options.browser && mapped.browser) options.browser = mapped.browser;
    if (!options.profileDirectory && mapped.profileDirectory) {
      options.profileDirectory = mapped.profileDirectory;
    }
    if (!options.userDataDir && mapped.userDataDir) {
      options.userDataDir = mapped.userDataDir;
    }
    if (!options.executablePath && mapped.executablePath) {
      options.executablePath = mapped.executablePath;
    }
  }

  // accounts.json is the canonical account label source. The browser mapping
  // may still provide launch details, but it must not resurrect stale labels.
  options.profileLabel = account.label;

  options.browser = normalizeBrowser(options.browser, options.executablePath);

  // Default local path includes account-alias suffix when known:
  // mindvideo-token-01-feng33feng35feng3.txt
  if (!options.output) {
    const nn = String(options.account).padStart(2, "0");
    const suffix = sanitizeFileSuffix(options.profileLabel);
    const fileName = suffix
      ? `mindvideo-token-${nn}-${suffix}.txt`
      : `mindvideo-token-${nn}.txt`;
    options.output = path.join("logs", fileName);
  }

  return options;
}

function normalizeBrowser(browser, executablePath) {
  const b = String(browser || "").trim().toLowerCase();
  if (b === "firefox" || b === "ff" || b === "mozilla") return "firefox";
  if (b === "chrome" || b === "chromium" || b === "edge" || b === "msedge" || b === "cdp") {
    return "chrome";
  }
  const exe = String(executablePath || "").toLowerCase();
  if (exe.includes("firefox")) return "firefox";
  return "chrome";
}

/** Safe filename segment from account alias (no path separators / reserved chars). */
function sanitizeFileSuffix(label) {
  if (!label || typeof label !== "string") return null;
  const trimmed = label.trim();
  if (!trimmed || /^account[-_]?\d+$/i.test(trimmed)) return null;
  const cleaned = trimmed
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "");
  return cleaned || null;
}

function loadChromeProfileMapping(accountNumber) {
  try {
    if (!fs.existsSync(CHROME_PROFILES_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(CHROME_PROFILES_FILE, "utf8"));
    const entry = raw?.[String(accountNumber)] || raw?.[accountNumber];
    if (!entry || typeof entry !== "object") return null;
    return {
      label: entry.label || null,
      browser: entry.browser || null,
      profileDirectory: entry.profileDirectory || entry.profile || null,
      userDataDir: entry.userDataDir || null,
      executablePath: entry.executablePath || entry.executable || null,
    };
  } catch (error) {
    console.warn(`Failed to read chrome-profiles.json: ${error.message}`);
    return null;
  }
}

function findSystemFirefox() {
  const candidates = [];
  if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Mozilla Firefox", "firefox.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Mozilla Firefox", "firefox.exe")
    );
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Firefox.app/Contents/MacOS/firefox");
  } else {
    candidates.push("/usr/bin/firefox", "/usr/bin/firefox-esr");
  }
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/**
 * Stock Mozilla Firefox is NOT compatible with Playwright's automation protocol
 * (launchPersistentContext often hangs; page never navigates; no in-page banner).
 * Only Playwright's own ms-playwright Firefox binary works reliably.
 */
function isStockMozillaFirefoxPath(executablePath) {
  const exe = String(executablePath || "").trim();
  if (!exe) return true;
  const lower = exe.replace(/\//g, "\\").toLowerCase();
  if (lower.includes("ms-playwright")) return false;
  if (lower.includes("playwright") && !lower.endsWith(".exe") && !lower.endsWith("firefox")) {
    return true;
  }
  const base = path.basename(lower);
  if (base !== "firefox.exe" && base !== "firefox" && base !== "firefox-bin") return false;
  if (lower.includes("mozilla firefox") || lower.includes("\\firefox\\")) return true;
  // Any non-ms-playwright firefox binary → treat as stock
  return !lower.includes("ms-playwright");
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function defaultFirefoxProfileDir(account) {
  const accountKey = account > 0 ? String(account).padStart(2, "0") : "xx";
  // Prefer LocalAppData ASCII path (no Chinese path segments).
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(
      process.env.LOCALAPPDATA,
      "MindVideo Auto Sign",
      "firefox-profiles",
      `account-${accountKey}`
    );
  }
  return path.join(process.cwd(), ".browser-profiles", `firefox-account-${accountKey}`);
}

function firefoxSystemProfilesRoot() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || "", "Mozilla", "Firefox", "Profiles");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Firefox", "Profiles");
  }
  return path.join(os.homedir(), ".mozilla", "firefox");
}

function isSystemFirefoxProfilesPath(dir) {
  if (!dir) return false;
  const normalized = path.resolve(dir).toLowerCase();
  return (
    normalized.includes(`${path.sep}mozilla${path.sep}firefox${path.sep}profiles`) ||
    /[\\/]mozilla[\\/]firefox[\\/]profiles(?:[\\/]|$)/i.test(normalized)
  );
}

/** True if path contains non-ASCII (e.g. 設定檔) — console / some tools may garble it. */
function hasNonAsciiPath(dir) {
  return /[^\x00-\x7F]/.test(String(dir || ""));
}

/**
 * Resolve a Firefox profile directory.
 * If the exact path is missing (encoding garble of 設定檔 etc.), match by profile id prefix
 * under Mozilla/Firefox/Profiles (e.g. hVesXz80.* → real folder name).
 */
function resolveExistingFirefoxProfile(requested) {
  const resolved = path.resolve(requested);
  try {
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // ignore
  }

  const base = path.basename(resolved);
  const prefix = base.includes(".") ? base.split(".")[0] : base;
  if (!prefix || prefix.length < 3) return resolved;

  const root = firefoxSystemProfilesRoot();
  try {
    if (!fs.existsSync(root)) return resolved;
    const match = fs.readdirSync(root).find(
      (name) => name === base || name.startsWith(`${prefix}.`) || name === prefix
    );
    if (match) {
      const fixed = path.join(root, match);
      console.warn(
        `[Firefox] Profile path not found as written; resolved by id prefix "${prefix}" →\n  ${fixed}`
      );
      return fixed;
    }
  } catch (error) {
    console.warn(`[Firefox] Could not scan Profiles folder: ${error.message}`);
  }
  return resolved;
}

function resolveFirefoxProfileDir(launchOpts = {}) {
  const account = Number(launchOpts.account) || 0;
  const fallback = defaultFirefoxProfileDir(account);
  let requested = (launchOpts.userDataDir || "").trim();
  if (!requested) return fallback;
  return resolveExistingFirefoxProfile(requested);
}

function isFirefoxProcessRunning() {
  try {
    if (process.platform === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq firefox.exe" /NH', {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      return /firefox\.exe/i.test(out);
    }
    if (process.platform === "darwin" || process.platform === "linux") {
      execSync("pgrep -x firefox || pgrep -x firefox-bin", {
        stdio: ["ignore", "ignore", "ignore"],
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Ensure profile is usable for launchPersistentContext.
 * - If parent.lock + firefox running → clear Traditional Chinese error
 * - If parent.lock + firefox NOT running → remove stale lock and continue
 */
function prepareFirefoxProfileForLaunch(profileDir) {
  const lockFile = path.join(profileDir, "parent.lock");
  const hasLock = fs.existsSync(lockFile);
  const firefoxRunning = isFirefoxProcessRunning();

  if (hasLock && firefoxRunning) {
    throw new Error(
      [
        "Firefox profile 已被鎖定（parent.lock），Playwright 無法同時使用同一個 Profile。",
        "",
        `Profile: ${profileDir}`,
        `Lock: ${lockFile}`,
        "",
        "請依序處理：",
        "1) 關閉所有 Firefox 視窗（不要只按 X 後仍留在背景）。",
        "2) 工作管理員（Ctrl+Shift+Esc）結束所有 firefox.exe。",
        "3) 再重試「Google 登入並擷取 Token」。",
        "",
        "更穩定做法：改用獨立英文路徑的專用 Profile（App 內按「還原 Firefox 預設」），",
        "例如 %LOCALAPPDATA%\\MindVideo Auto Sign\\firefox-profiles\\account-NN",
        "首次在該專用 Profile 登入一次 Google 即可，不要用日常上網的 Profile。",
      ].join("\n")
    );
  }

  if (hasLock && !firefoxRunning) {
    try {
      fs.unlinkSync(lockFile);
      console.warn(
        `[Firefox] Removed stale parent.lock (Firefox not running):\n  ${lockFile}`
      );
    } catch (error) {
      throw new Error(
        [
          "Firefox profile 有 parent.lock，且無法刪除（可能權限不足或仍被占用）。",
          `Lock: ${lockFile}`,
          error.message,
          "",
          "請手動確認 firefox.exe 已全部結束後刪除 parent.lock，或改用專用 Profile。",
        ].join("\n")
      );
    }
  }

  if (hasNonAsciiPath(profileDir)) {
    console.warn(
      "[Firefox] Profile path contains non-ASCII characters (e.g. 設定檔)."
    );
    console.warn(
      "[Firefox] Prefer an English-only dedicated profile under MindVideo Auto Sign\\firefox-profiles\\account-NN."
    );
  }

  if (isSystemFirefoxProfilesPath(profileDir)) {
    console.warn(
      "[Firefox] Using a system Mozilla\\Firefox\\Profiles path — do not keep Firefox open."
    );
  } else {
    fs.mkdirSync(profileDir, { recursive: true });
  }
}

function defaultChromeUserDataDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  }
  return path.join(os.homedir(), ".config", "google-chrome");
}

function isChromeRunning() {
  try {
    if (process.platform === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      return /chrome\.exe/i.test(out);
    }
    if (process.platform === "darwin" || process.platform === "linux") {
      execSync("pgrep -x 'Google Chrome' || pgrep -x chrome || pgrep -x google-chrome", {
        stdio: ["ignore", "ignore", "ignore"],
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright is not installed. Run: npm install");
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

  const visit = (value, keyHint = "") => {
    if (!value) return;
    if (typeof value === "string") {
      const token = clean(value);
      if (token) candidates.push(token);
      try {
        visit(JSON.parse(value), keyHint);
      } catch {
        // plain string
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, keyHint));
      return;
    }
    if (typeof value === "object") {
      // Profile markers after a real MindVideo login.
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
        visit(child, key);
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
        visit(raw, key);
        if (raw && raw.length > 2) hasUserProfile = hasUserProfile || /email|nickname|user_id|username/i.test(raw);
      } else {
        visit(raw, key);
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

function maskToken(token) {
  if (!token || token.length <= 16) return "***";
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}

function isMindVideoApiUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "api-app.mindvideo.ai" || host.endsWith(".mindvideo.ai");
  } catch {
    return false;
  }
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

  // Dead / expired token.
  if (response.status === 401 || payload?.code === 20001) {
    return {
      ok: false,
      reason: payload?.message || `HTTP ${response.status} unauthorized`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: payload?.message || `HTTP ${response.status}`,
    };
  }

  // MindVideo success is usually code === 0.
  if (payload?.code !== undefined && payload.code !== 0) {
    return {
      ok: false,
      reason: `${payload.code} ${payload.message || "MindVideo API error"}`,
    };
  }

  return { ok: true, payload };
}

async function setPageBanner(page, message, kind = "waiting") {
  try {
    await page.evaluate(
      ({ message, kind }) => {
        const colors = {
          waiting: "#0f4c5c",
          checking: "#854d0e",
          ok: "#0f766e",
          error: "#b91c1c",
        };
        let el = document.getElementById("mv-token-capture-banner");
        if (!el) {
          el = document.createElement("div");
          el.id = "mv-token-capture-banner";
          el.style.cssText = [
            "position:fixed",
            "z-index:2147483647",
            "left:16px",
            "right:16px",
            "top:16px",
            "padding:14px 18px",
            "border-radius:10px",
            "font:600 14px/1.45 system-ui,sans-serif",
            "box-shadow:0 8px 24px rgba(0,0,0,.18)",
            "color:#fff",
            "pointer-events:none",
          ].join(";");
          (document.body || document.documentElement).appendChild(el);
        }
        el.textContent = message;
        el.style.background = colors[kind] || colors.waiting;
      },
      { message, kind }
    );
  } catch {
    // Navigation can invalidate evaluate; ignore.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findSystemBrowser() {
  const candidates = [];
  if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/usr/bin/microsoft-edge"
    );
  }
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Wait until Chrome DevTools HTTP endpoint is actually up.
 * ECONNREFUSED means nothing is listening — never call connectOverCDP before this succeeds.
 */
async function waitForCdpHttp(port, options = {}) {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const child = options.child || null;
  const deadline = Date.now() + timeoutMs;
  const versionUrl = `http://127.0.0.1:${port}/json/version`;
  let lastError = null;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;

    if (child && child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(
        `Chrome process exited before CDP was ready (exitCode=${child.exitCode}, signal=${child.signalCode || "none"}). ` +
          `This usually means Chrome handed off to an already-running instance without enabling remote debugging, ` +
          `or the executable/path/profile is wrong. stderr: ${(options.stderr || "").trim() || "(empty)"}`
      );
    }

    try {
      const response = await fetch(versionUrl, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        const body = await response.text();
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          // still treat HTTP 200 as ready if body is non-empty
        }
        if (parsed?.webSocketDebuggerUrl || body.includes("webSocketDebuggerUrl") || body.includes("Browser")) {
          console.log(`[CDP] Ready after ${attempts} attempt(s): ${versionUrl}`);
          if (parsed?.Browser) console.log(`[CDP] Browser: ${parsed.Browser}`);
          if (parsed?.webSocketDebuggerUrl) {
            console.log(`[CDP] webSocketDebuggerUrl: ${parsed.webSocketDebuggerUrl}`);
          }
          return parsed || { raw: body };
        }
      }
      lastError = new Error(`HTTP ${response.status} from ${versionUrl}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(350);
  }

  const listening = await isPortListening(port);
  throw new Error(
    [
      `CDP endpoint not ready: ${versionUrl}`,
      `lastError=${lastError?.message || lastError}`,
      `portListening=${listening}`,
      `chromeStillRunning=${child ? child.exitCode === null : "unknown"}`,
      `pid=${child?.pid || "n/a"}`,
      `stderr=${(options.stderr || "").trim() || "(empty)"}`,
      "",
      "Diagnose:",
      `1) Open ${versionUrl} in a browser — must return JSON with webSocketDebuggerUrl.`,
      "2) Task Manager must show chrome.exe after launch.",
      `3) netstat -ano | findstr ${port}`,
      "4) Chrome requires a non-default --user-data-dir (never Chrome\\User Data + Profile N).",
      "5) Confirm chrome.exe path exists and antivirus is not blocking --remote-debugging-port.",
    ].join("\n")
  );
}

/**
 * Chrome refuses remote debugging on the real install User Data folder:
 * "DevTools remote debugging requires a non-default data directory."
 * Always use a dedicated directory outside the system Chrome profile tree.
 */
function isForbiddenSystemChromeUserDataDir(dir) {
  if (!dir) return false;
  const normalized = path.resolve(dir).toLowerCase();
  const system = path.resolve(defaultChromeUserDataDir()).toLowerCase();
  if (normalized === system) return true;
  // Also block nested paths under the system User Data (e.g. .../User Data/Profile 2)
  if (normalized.startsWith(system + path.sep) || normalized.startsWith(system + "/")) {
    return true;
  }
  // Common Windows path shape even if LOCALAPPDATA differs in casing
  return /[\\/]google[\\/]chrome[\\/]user data(?:[\\/]|$)/i.test(normalized);
}

function resolveCdpUserDataDir(launchOpts = {}) {
  const account = Number(launchOpts.account) || 0;
  const accountKey = account > 0 ? String(account).padStart(2, "0") : "xx";
  const defaultDir = path.join(
    process.cwd(),
    ".browser-profiles",
    `cdp-account-${accountKey}`
  );

  let requested = (launchOpts.userDataDir || "").trim();
  if (!requested) {
    return defaultDir;
  }

  requested = path.resolve(requested);
  if (isForbiddenSystemChromeUserDataDir(requested)) {
    console.warn(
      `[CDP] Ignoring forbidden system Chrome user-data-dir: ${requested}`
    );
    console.warn(
      `[CDP] Chrome blocks remote debugging on the default User Data directory.`
    );
    console.warn(`[CDP] Using dedicated directory instead: ${defaultDir}`);
    return defaultDir;
  }
  return requested;
}

function buildChromeArgs({ port, userDataDir, startUrl }) {
  // Do NOT pass --profile-directory for CDP launches.
  // Pairing system profiles (Default / Profile N) with remote debugging is rejected
  // or silently ignored by modern Chrome.
  return [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=TranslateUI,ChromeWhatsNewUI",
    "--disable-popup-blocking",
    "--disable-background-networking",
    "--window-size=1365,900",
    // Intentionally NOT using --enable-automation / Playwright Chromium.
    startUrl || DEFAULT_URL,
  ];
}

/**
 * Launch real Chrome/Edge and attach via CDP.
 *
 * Chrome rule (current): remote debugging requires a non-default --user-data-dir.
 * Never point user-data-dir at %LOCALAPPDATA%\Google\Chrome\User Data.
 * Never rely on --profile-directory=Default|Profile N for CDP.
 *
 * Google login cookies persist inside the dedicated CDP profile folder per account.
 */
async function launchRealBrowserViaCdp(chromium, startUrl, launchOpts = {}) {
  const executable =
    (launchOpts.executablePath && fs.existsSync(launchOpts.executablePath)
      ? launchOpts.executablePath
      : null) || findSystemBrowser();
  if (!executable) {
    throw new Error(
      "找不到本機 Chrome / Edge。請安裝 Google Chrome，或在 App 內設定正確的 chrome.exe 路徑。"
    );
  }
  if (!fs.existsSync(executable)) {
    throw new Error(`chrome.exe not found: ${executable}`);
  }

  if (launchOpts.profileDirectory) {
    console.warn(
      `[CDP] Note: --profile-directory=${launchOpts.profileDirectory} is NOT used for CDP.`
    );
    console.warn(
      "[CDP] System profiles (Default / Profile N) cannot enable remote debugging."
    );
    console.warn(
      "[CDP] Using a dedicated --user-data-dir instead; complete Google login once in that window."
    );
  }

  const userDataDir = resolveCdpUserDataDir(launchOpts);
  fs.mkdirSync(userDataDir, { recursive: true });

  const port = await getFreePort();
  const args = buildChromeArgs({ port, userDataDir, startUrl });

  console.log(`[CDP] Launching: ${executable}`);
  console.log(`[CDP] Args: ${args.join(" ")}`);
  console.log(`[CDP] user-data-dir (dedicated, non-default): ${userDataDir}`);
  console.log(`[CDP] Expect DevTools at http://127.0.0.1:${port}/json/version`);
  console.log(
    "[CDP] Tip: first run needs Google login once; later runs reuse cookies in this folder."
  );

  let stderr = "";
  let stdout = "";
  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    // Do NOT detach: we need exitCode to detect "Chrome handed off / failed to start".
    detached: false,
    windowsHide: false,
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("error", (error) => {
    console.error(`[CDP] spawn error: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    console.log(`[CDP] chrome process exit code=${code} signal=${signal}`);
  });

  // Give the process a moment to either listen or die.
  await sleep(800);
  if (child.exitCode !== null && child.exitCode !== undefined) {
    const stderrText = stderr.trim() || "(empty)";
    const defaultDirHint = /non-default data directory|remote debugging requires/i.test(
      stderrText
    )
      ? "\nChrome rejected the data directory — never use the system Chrome\\User Data path for CDP."
      : "";
    throw new Error(
      [
        "CDP Chrome launch failed: chrome.exe exited immediately.",
        `exitCode=${child.exitCode}`,
        `executable=${executable}`,
        `user-data-dir=${userDataDir}`,
        `stderr=${stderrText}`,
        `stdout=${stdout.trim() || "(empty)"}`,
        defaultDirHint,
        "",
        "Most common causes:",
        "1) user-data-dir pointed at the real Chrome User Data (forbidden for DevTools).",
        "2) Wrong chrome.exe path.",
        "3) Antivirus blocked --remote-debugging-port.",
        `4) Manually test:`,
        `   "${executable}" --remote-debugging-port=${port} --remote-allow-origins=* --user-data-dir="${userDataDir}" about:blank`,
        `   then open http://127.0.0.1:${port}/json/version`,
      ].join("\n")
    );
  }

  const endpoint = `http://127.0.0.1:${port}`;
  try {
    await waitForCdpHttp(port, { timeoutMs: 40_000, child, stderr });
  } catch (error) {
    try {
      if (child.exitCode === null) child.kill();
    } catch {
      // ignore
    }
    throw new Error(
      [
        "CDP Chrome launch failed",
        `CDP ${endpoint}`,
        String(error.message || error),
        "",
        "retrieving websocket url from " + endpoint + " failed because nothing accepted the connection.",
        "ECONNREFUSED means: no Chrome is listening on that port.",
        "DevTools remote debugging requires a non-default --user-data-dir (not Chrome\\User Data).",
      ].join("\n")
    );
  }

  try {
    const browser = await chromium.connectOverCDP(endpoint);
    console.log(`[CDP] Connected over CDP: ${endpoint}`);
    return {
      browser,
      child,
      mode: "cdp",
      endpoint,
      // Dedicated CDP profile — safe to close when capture finishes.
      useSystemProfile: false,
      profileDirectory: null,
      userDataDir,
    };
  } catch (error) {
    try {
      if (child.exitCode === null) child.kill();
    } catch {
      // ignore
    }
    throw new Error(
      [
        "CDP Chrome launch failed after /json/version was reachable.",
        `endpoint=${endpoint}`,
        error.message || String(error),
        "Try updating Chrome/Playwright; --remote-allow-origins=* is already set.",
      ].join("\n")
    );
  }
}

/** Fallback: Playwright channel=chrome with automation flags stripped. */
async function launchStealthPersistent(chromium, startUrl, launchOpts = {}) {
  const userDataDir = launchOpts.profileDirectory
    ? launchOpts.userDataDir || defaultChromeUserDataDir()
    : ISOLATED_PROFILE_DIR;
  if (!launchOpts.profileDirectory) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }
  const common = {
    headless: false,
    viewport: { width: 1365, height: 900 },
    locale: "zh-TW",
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      ...(launchOpts.profileDirectory
        ? [`--profile-directory=${launchOpts.profileDirectory}`]
        : []),
      `--app=${startUrl || DEFAULT_URL}`,
    ],
  };

  for (const channel of ["chrome", "msedge", undefined]) {
    try {
      const context = await chromium.launchPersistentContext(userDataDir, {
        ...common,
        ...(channel ? { channel } : {}),
        ...(launchOpts.executablePath ? { executablePath: launchOpts.executablePath } : {}),
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          get: () => undefined,
        });
      });
      console.log(`Launched persistent context: ${channel || "chromium"}`);
      return { browser: context.browser(), context, mode: "persistent" };
    } catch (error) {
      console.warn(`Persistent launch failed (${channel || "chromium"}): ${error.message}`);
    }
  }
  throw new Error("無法啟動可用的瀏覽器進行 Google 登入。");
}

/**
 * Launch Firefox via Playwright persistent context.
 * userDataDir is the Firefox profile directory (not a parent of profiles).
 *
 * IMPORTANT: always use Playwright's bundled Firefox. Stock Mozilla firefox.exe
 * hangs on launchPersistentContext and never reaches mindvideo.ai / page banner.
 */
async function launchFirefoxPersistent(playwright, startUrl, launchOpts = {}) {
  const { firefox } = playwright;
  if (!firefox) {
    throw new Error(
      "Playwright firefox 不可用。請執行：npx playwright install firefox"
    );
  }

  const requestedExe =
    launchOpts.executablePath && fs.existsSync(launchOpts.executablePath)
      ? launchOpts.executablePath
      : null;
  // Never pass stock Mozilla Firefox to Playwright — it hangs and skips navigation.
  let executable = null;
  if (requestedExe && !isStockMozillaFirefoxPath(requestedExe)) {
    executable = requestedExe;
  } else if (requestedExe && isStockMozillaFirefoxPath(requestedExe)) {
    console.warn(
      `[Firefox] Ignoring stock Mozilla path (incompatible with Playwright):\n  ${requestedExe}`
    );
    console.warn(
      "[Firefox] Using Playwright bundled Firefox instead. Leave executable empty in the app."
    );
  }

  const profileDir = resolveFirefoxProfileDir(launchOpts);
  prepareFirefoxProfileForLaunch(profileDir);
  const targetUrl = startUrl || DEFAULT_URL;

  console.log(`[Firefox] Launching Playwright persistent context`);
  console.log(`[Firefox] executable: ${executable || "(Playwright bundled firefox)"}`);
  console.log(`[Firefox] profile: ${profileDir}`);
  console.log(`[Firefox] will open: ${targetUrl}`);
  console.log(
    "[Firefox] Tip: first run needs Google login once; later runs reuse cookies in this profile."
  );

  try {
    const context = await withTimeout(
      firefox.launchPersistentContext(profileDir, {
        headless: false,
        viewport: { width: 1365, height: 900 },
        locale: "zh-TW",
        ...(executable ? { executablePath: executable } : {}),
        // Pass URL as arg so the first window is not stuck on about:blank / restore.
        args: [targetUrl],
        firefoxUserPrefs: {
          "dom.webdriver.enabled": false,
          "useAutomationExtension": false,
          // Avoid session restore fighting our goto / start URL.
          "browser.startup.page": 0,
          "browser.sessionstore.resume_from_crash": false,
          "browser.sessionstore.max_resumed_crashes": 0,
          "browser.shell.checkDefaultBrowser": false,
          "datareporting.policy.dataSubmissionEnabled": false,
          "toolkit.telemetry.reportingpolicy.firstRun": false,
        },
      }),
      60_000,
      "Firefox launchPersistentContext"
    );

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
    });

    const page = context.pages()[0] || (await context.newPage());
    console.log(`[Firefox] Initial page url: ${page.url()}`);

    // Force navigation even if session restore or args URL failed.
    let navigated = false;
    const candidates = [
      targetUrl,
      DEFAULT_URL,
      "https://www.mindvideo.ai/auth/signin/",
      "https://www.mindvideo.ai/zh/auth/signin/",
      "https://mindvideo.ai/auth/signin/",
    ].filter((value, index, all) => value && all.indexOf(value) === index);

    for (const url of candidates) {
      try {
        console.log(`[Firefox] Navigating → ${url}`);
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        const now = page.url();
        console.log(`[Firefox] After goto: ${now}`);
        if (/mindvideo\.ai/i.test(now)) {
          navigated = true;
          break;
        }
      } catch (error) {
        console.warn(`[Firefox] Navigation warning (${url}): ${error.message}`);
      }
    }

    if (!navigated) {
      console.warn(
        "[Firefox] Could not confirm mindvideo.ai URL yet; will retry in openGoogleLogin."
      );
    }

    // Immediate user-visible prompt (works even before SPA fully hydrates).
    try {
      await setPageBanner(
        page,
        navigated
          ? "此帳號為 Google 帳號：請用「Login with Google / 使用 Google 登入」。登入成功後維持 ≥5 秒會擷取 Token。"
          : "正在開啟 MindVideo 登入頁…若沒有自動跳轉，請手動前往 https://www.mindvideo.ai/auth/signin/",
        "waiting"
      );
      console.log("[Firefox] Page banner injected");
    } catch (error) {
      console.warn(`[Firefox] Banner inject warning: ${error.message}`);
    }

    console.log("[Firefox] Persistent context ready");
    return {
      browser: context.browser(),
      context,
      mode: "firefox-persistent",
      userDataDir: profileDir,
      // Dedicated profiles are safe to close; system profiles we still close Playwright context.
      useSystemProfile: false,
    };
  } catch (error) {
    const msg = String(error.message || error);
    if (/timed out/i.test(msg)) {
      throw new Error(
        [
          "Firefox 啟動逾時：通常是設定了系統 Mozilla firefox.exe（與 Playwright 不相容）。",
          msg,
          "",
          "處理方式：",
          "1) App 內「瀏覽器執行檔」留空，或按「還原 Firefox 預設」",
          "2) 執行：npx playwright install firefox",
          "3) 工作管理員結束殘留的 firefox.exe 後重試",
          `Profile: ${profileDir}`,
        ].join("\n")
      );
    }
    if (/lock|profile|busy|in use/i.test(msg)) {
      throw new Error(
        [
          "Firefox 啟動失敗：Profile 可能仍被鎖定或占用。",
          msg,
          "",
          "處理方式：",
          "1) 工作管理員結束所有 firefox.exe",
          "2) 若 Firefox 已關，刪除該 Profile 內的 parent.lock",
          "3) 建議改用專用英文路徑：%LOCALAPPDATA%\\MindVideo Auto Sign\\firefox-profiles\\account-NN",
          `目前 Profile: ${profileDir}`,
        ].join("\n")
      );
    }
    throw new Error(
      `Firefox 啟動失敗：${msg}\n若尚未安裝瀏覽器二進位：npx playwright install firefox\nProfile: ${profileDir}`
    );
  }
}

async function openBrowserSession(playwright, startUrl, launchOpts = {}) {
  const browserKind = normalizeBrowser(launchOpts.browser, launchOpts.executablePath);
  launchOpts.browser = browserKind;

  if (browserKind === "firefox") {
    return launchFirefoxPersistent(playwright, startUrl, launchOpts);
  }

  const { chromium } = playwright;
  try {
    return await launchRealBrowserViaCdp(chromium, startUrl, launchOpts);
  } catch (error) {
    console.warn(`CDP Chrome launch failed: ${error.message}`);
    // Never fall back to isolated profile when user asked for a specific system profile.
    if (launchOpts.profileDirectory) throw error;
    console.warn("Falling back to Playwright persistent Chrome profile…");
    return launchStealthPersistent(chromium, startUrl, launchOpts);
  }
}

async function getWorkingPage(session) {
  if (session.mode === "cdp") {
    const contexts = session.browser.contexts();
    const context = contexts[0] || (await session.browser.newContext());
    session.context = context;
    const pages = context.pages();
    if (pages.length > 0) return pages[0];
    return context.newPage();
  }
  // persistent / firefox-persistent
  const pages = session.context.pages();
  if (pages.length > 0) return pages[0];
  return session.context.newPage();
}

async function closeBrowserSession(session) {
  // For system browser profiles: do not force-kill the user's main browser.
  const keepAlive = Boolean(session?.useSystemProfile);

  if (keepAlive) {
    console.log(
      "Leaving system browser profile open. Close the window manually when done."
    );
    // Still detach Playwright cleanly without killing if possible.
    try {
      if (session?.context && (session.mode === "persistent" || session.mode === "firefox-persistent")) {
        await session.context.close().catch(() => {});
      }
    } catch {
      // ignore
    }
    return;
  }

  try {
    if (session?.context && (session.mode === "persistent" || session.mode === "firefox-persistent")) {
      await session.context.close().catch(() => {});
    }
  } catch {
    // ignore
  }
  try {
    if (session?.browser) {
      await session.browser.close().catch(() => {});
    }
  } catch {
    // ignore
  }

  if (session?.child?.pid) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(session.child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        process.kill(-session.child.pid, "SIGTERM");
      }
    } catch {
      try {
        process.kill(session.child.pid);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Navigate to MindVideo sign-in and click "Login with Google" when present.
 * User still completes the Google account picker / password themselves.
 */
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

    await setPageBanner(
      page,
      "此帳號為 Google 帳號：請使用「Login with Google / 使用 Google 登入」。正在嘗試自動開啟…",
      "waiting"
    );

    // Give the SPA a moment to render OAuth buttons.
    await sleep(1500);

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

      const candidates = [
        ...document.querySelectorAll(
          'a, button, [role="button"], div[class*="google" i], span[class*="google" i]'
        ),
      ];

      for (const el of candidates) {
        const text = `${el.innerText || el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("href") || ""}`;
        if (!looksLikeGoogle(text)) continue;
        if (!isVisible(el)) continue;
        el.click();
        return true;
      }

      // Fallback: any link pointing at Google OAuth.
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || "";
        if (/accounts\.google\.com|google.*oauth|\/auth\/.*google|provider=google/i.test(href) && isVisible(a)) {
          a.click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      console.log("Clicked MindVideo「Login with Google」.");
      await setPageBanner(
        page,
        "已開啟 Google 登入。請選擇對應的 Google 帳號完成授權；登入成功後會自動擷取 Token。",
        "waiting"
      );
      return;
    }
  }

  console.log("Could not auto-click Google login; please click「Login with Google」manually.");
  await setPageBanner(
    page,
    "此帳號為 Google 帳號：請手動點「Login with Google / 使用 Google 登入」完成登入。",
    "waiting"
  );
}

async function main() {
  const options = parseArgs();
  const playwright = await loadPlaywright();
  const secretName = getSecretName(options.account);
  const browserKind = normalizeBrowser(options.browser, options.executablePath);

  const launchOpts = {
    account: options.account,
    browser: browserKind,
    profileDirectory: options.profileDirectory,
    userDataDir: options.userDataDir,
    executablePath: options.executablePath,
    profileLabel: options.profileLabel || null,
  };

  if (browserKind === "firefox") {
    console.log(
      `[${secretName}] Browser=Firefox (Playwright persistent)` +
        (launchOpts.profileLabel ? ` · ${launchOpts.profileLabel}` : "")
    );
    console.log(`[${secretName}] Target URL: ${options.url || DEFAULT_URL}`);
    if (launchOpts.executablePath && isStockMozillaFirefoxPath(launchOpts.executablePath)) {
      console.warn(
        `[${secretName}] executable-path is stock Mozilla Firefox — will use Playwright bundled Firefox.`
      );
      launchOpts.executablePath = null;
    }
  } else if (launchOpts.profileDirectory) {
    console.log(
      `[${secretName}] Using Chrome profile-directory="${launchOpts.profileDirectory}"` +
        (launchOpts.profileLabel ? ` (${launchOpts.profileLabel})` : "") +
        ` as label; CDP uses dedicated user-data-dir.`
    );
  } else {
    console.log(
      `[${secretName}] Opening isolated Chrome/Edge for Google login (no browser profile mapping).`
    );
  }

  const session = await openBrowserSession(playwright, options.url || DEFAULT_URL, launchOpts);
  try {
    const page = await getWorkingPage(session);
    const context = session.context;

    /** @type {{ token: string, source: string } | null} */
    let networkToken = null;
    context.on("request", (request) => {
      if (!isMindVideoApiUrl(request.url())) return;
      const authorization = request.headers().authorization || "";
      if (!authorization.toLowerCase().startsWith("bearer ")) return;
      const token = authorization.slice("bearer ".length).trim();
      if (token.length >= MIN_TOKEN_LENGTH) {
        networkToken = { token, source: "network" };
      }
    });

    // Also watch new pages (Google OAuth popup / redirect tabs).
    context.on("page", (newPage) => {
      newPage.on("request", (request) => {
        if (!isMindVideoApiUrl(request.url())) return;
        const authorization = request.headers().authorization || "";
        if (!authorization.toLowerCase().startsWith("bearer ")) return;
        const token = authorization.slice("bearer ".length).trim();
        if (token.length >= MIN_TOKEN_LENGTH) {
          networkToken = { token, source: "network" };
        }
      });
    });

    const waitingBanner =
      browserKind === "firefox"
        ? "此帳號為 Google 帳號：請用「Login with Google」登入。此視窗為 Firefox（Playwright）。登入成功後維持 ≥5 秒會擷取 Token。"
        : "此帳號為 Google 帳號：請用「Login with Google」登入。此視窗為本機 Chrome/Edge（非自動化 Chromium）。登入成功後維持 ≥5 秒會擷取 Token。";

    page.on("framenavigated", async (frame) => {
      if (frame === page.mainFrame()) {
        const url = frame.url();
        if (/mindvideo\.ai/i.test(url)) {
          await setPageBanner(page, waitingBanner, "waiting");
        }
      }
    });

    await openGoogleLogin(page, options.url || DEFAULT_URL);

    const deadline = Date.now() + options.timeoutMs;
    let lastStatus = "";
    let captured = false;
    let lastFailReason = "";
    const outputPath = path.resolve(options.output);
    /**
     * Hold timer starts only after API confirms the token (not on first sighting).
     * Token string may rotate during hold; only full disappearance (with grace) resets it.
     * @type {{ token: string, holdStartedAt: number, missStreak: number } | null}
     */
    let hold = null;
    /** Allow brief SPA navigations to drop storage without restarting the 5s hold. */
    const HOLD_MISS_GRACE = 6; // ~3s at POLL_MS=500

    async function readLoginStateFromAnyPage() {
      const empty = {
        token: null,
        loggedIn: false,
        source: null,
        hasUserProfile: false,
        preferredToken: null,
      };
      const pages = context.pages();
      for (const p of pages) {
        try {
          const url = p.url();
          if (!/mindvideo\.ai/i.test(url)) continue;
          const state = await p.evaluate(inspectLoginState);
          if (state?.token || state?.loggedIn) return { state, page: p };
        } catch {
          // navigate mid-evaluate
        }
      }
      // Fallback: active page even if URL not yet mindvideo
      try {
        const state = await page.evaluate(inspectLoginState);
        return { state: state || empty, page };
      } catch {
        return { state: empty, page };
      }
    }

    while (Date.now() < deadline) {
      const { state, page: activePage } = await readLoginStateFromAnyPage();

      const candidate =
        (state.loggedIn && state.token
          ? { token: state.token, source: state.source || "storage" }
          : null) ||
        (networkToken && state.hasUserProfile ? networkToken : null) ||
        // Accept network token only after storage also shows a token (login completed).
        (networkToken && state.token ? networkToken : null) ||
        (state.token && state.preferredToken
          ? { token: state.preferredToken, source: "user.token" }
          : null);

      if (!candidate?.token) {
        if (hold) {
          hold.missStreak = (hold.missStreak || 0) + 1;
          if (hold.missStreak >= HOLD_MISS_GRACE) {
            console.log(`[${secretName}] Login dropped during 5s hold; restarting…`);
            hold = null;
          } else {
            // Keep hold timer; SPA navigation can blank storage for a poll or two.
            await setPageBanner(
              activePage,
              `已確認登入。頁面切換中，仍繼續倒數…（${((Date.now() - hold.holdStartedAt) / 1000).toFixed(1)}s / 5s）`,
              "checking"
            );
            await sleep(POLL_MS);
            continue;
          }
        }
        const status = state.token
          ? "token present but login profile not confirmed yet; keep browsing after login…"
          : "waiting for MindVideo login…";
        if (status !== lastStatus) {
          console.log(`[${secretName}] ${status}`);
          lastStatus = status;
        }
        try {
          await setPageBanner(activePage, waitingBanner, "waiting");
        } catch {
          // ignore
        }
        await sleep(POLL_MS);
        continue;
      }

      // JWT / storage token often rotates while still logged in. Track the latest
      // token but DO NOT reset the 5s hold — resetting caused an infinite banner loop
      // at "已確認登入…（4.6s / 5s）".
      if (hold && hold.token !== candidate.token) {
        console.log(
          `[${secretName}] Token refreshed during hold (${maskToken(hold.token)} → ${maskToken(candidate.token)}); timer continues.`
        );
        hold.token = candidate.token;
      }
      if (hold) hold.missStreak = 0;

      // Not yet in hold: verify with API first, then start the 5s clock.
      if (!hold) {
        await setPageBanner(activePage, "偵測到登入，正在向 MindVideo API 驗證 Token…", "checking");
        const verification = await verifyTokenWithApi(candidate.token);
        if (!verification.ok) {
          lastFailReason = verification.reason;
          console.log(
            `[${secretName}] Token not accepted yet (${verification.reason}). Continue until fully logged in…`
          );
          await setPageBanner(
            activePage,
            `Token 尚無效（${verification.reason}）。請確認已完整登入 MindVideo。`,
            "error"
          );
          if (networkToken?.token === candidate.token) networkToken = null;
          await sleep(POLL_MS);
          continue;
        }

        hold = { token: candidate.token, holdStartedAt: Date.now(), missStreak: 0 };
        console.log(
          `[${secretName}] API OK (${VERIFY_ENDPOINT}). Holding login ≥${LOGIN_HOLD_MS / 1000}s, then capture token, then close.`
        );
        lastStatus = "holding";
      }

      const heldMs = Date.now() - hold.holdStartedAt;
      const remainMs = Math.max(0, LOGIN_HOLD_MS - heldMs);
      const heldSec = (heldMs / 1000).toFixed(1);
      const remainSec = Math.ceil(remainMs / 1000);

      if (heldMs < LOGIN_HOLD_MS) {
        await setPageBanner(
          activePage,
          `已確認登入。${remainSec} 秒後擷取 Token，再自動關閉視窗…（${heldSec}s / 5s）`,
          "checking"
        );
        const status = `holding login ${heldSec}s / ${LOGIN_HOLD_MS / 1000}s before capture…`;
        if (status !== lastStatus) {
          console.log(`[${secretName}] ${status}`);
          lastStatus = status;
        }
        await sleep(POLL_MS);
        continue;
      }

      // Full 5s elapsed: capture the latest token still present (rotation is OK).
      const { state: stillIn } = await readLoginStateFromAnyPage();
      const stillToken =
        stillIn?.preferredToken ||
        stillIn?.token ||
        candidate.token ||
        hold.token ||
        null;
      // Only restart if the token vanished entirely — not when it merely rotated.
      if (!stillToken || stillToken.length < MIN_TOKEN_LENGTH) {
        console.log(
          `[${secretName}] Login no longer stable after 5s hold (token missing); restarting…`
        );
        hold = null;
        await sleep(POLL_MS);
        continue;
      }

      const finalCheck = await verifyTokenWithApi(stillToken);
      if (!finalCheck.ok) {
        lastFailReason = finalCheck.reason;
        console.log(`[${secretName}] Token failed final check (${finalCheck.reason}); restarting…`);
        if (networkToken?.token === stillToken) networkToken = null;
        hold = null;
        await sleep(POLL_MS);
        continue;
      }

      // ── Capture token BEFORE closing the browser ──
      const tokenToSave = stillToken.trim();
      if (!tokenToSave || tokenToSave.length < MIN_TOKEN_LENGTH) {
        lastFailReason = "token empty or too short at capture time";
        hold = null;
        await sleep(POLL_MS);
        continue;
      }

      await setPageBanner(activePage, "正在擷取 Token（視窗尚未關閉）…", "checking");
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${tokenToSave}\n`, "utf8");

      // Confirm the file is on disk before we allow close.
      const written = fs.existsSync(outputPath)
        ? fs.readFileSync(outputPath, "utf8").trim()
        : "";
      if (written !== tokenToSave) {
        lastFailReason = "failed to write token file before close";
        console.error(`[${secretName}] ${lastFailReason}`);
        hold = null;
        await sleep(POLL_MS);
        continue;
      }

      captured = true;
      console.log(
        `[${secretName}] Token captured (browser still open): ${maskToken(tokenToSave)} → ${outputPath}`
      );
      await setPageBanner(activePage, "Token 已擷取完成。即將自動關閉視窗…", "ok");
      // Let the user see capture success, then close.
      await sleep(1000);
      console.log(`[${secretName}] Closing browser after successful token capture.`);
      break;
    }

    if (!captured) {
      const hint = lastFailReason ? ` Last API error: ${lastFailReason}.` : "";
      throw new Error(
        `Timed out waiting for a verified MindVideo login held ≥5s (${Math.round(options.timeoutMs / 1000)}s).${hint} Please log in fully in the browser and try again.`
      );
    }
  } finally {
    // Close only after capture (or on error). Token file is already written when successful.
    await closeBrowserSession(session);
  }
}

main().catch((error) => {
  console.error(`Token capture failed: ${error.message}`);
  process.exitCode = 1;
});
