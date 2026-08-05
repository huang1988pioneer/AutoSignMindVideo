import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

const port = await freePort();
const exe = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const userDataDir = path.join(process.cwd(), ".browser-profiles", "cdp-smoke");
fs.mkdirSync(userDataDir, { recursive: true });

const args = [
  `--remote-debugging-port=${port}`,
  "--remote-debugging-address=127.0.0.1",
  "--remote-allow-origins=*",
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
];

console.log("launch", exe, args.join(" "));
const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const versionUrl = `http://127.0.0.1:${port}/json/version`;
const deadline = Date.now() + 20_000;
let ready = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null) {
    console.error("chrome exited", child.exitCode, stderr);
    process.exit(1);
  }
  try {
    const response = await fetch(versionUrl);
    if (response.ok) {
      const json = await response.json();
      console.log("SMOKE /json/version OK", json.Browser);
      ready = true;
      break;
    }
  } catch {
    // wait
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

if (!ready) {
  console.error("SMOKE FAIL: no /json/version", stderr);
  process.exit(1);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
console.log("connectOverCDP OK", browser.contexts().length);
await browser.close();
try {
  child.kill();
} catch {
  // ignore
}
console.log("SMOKE PASS");
