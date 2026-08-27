import assert from "node:assert/strict";
import fs from "node:fs";

const workflowPath = new URL(
  "../.github/workflows/mindvideo-daily-checkin.yml",
  import.meta.url,
);
const workflow = fs.readFileSync(workflowPath, "utf8");

const expectedCrons = ["9 21 * * *", "9 5 * * *", "9 13 * * *"];
const actualCrons = [...workflow.matchAll(/^\s*- cron:\s*["']([^"']+)["']\s*$/gm)].map(
  ([, cron]) => cron,
);

assert.deepEqual(
  actualCrons,
  expectedCrons,
  "daily workflow must run 9 minutes after AutoSignLitVideo's 05:00/13:00/21:00 Taipei windows",
);

for (const cron of expectedCrons) {
  assert.ok(
    workflow.includes(`github.event.schedule == '${cron}'`),
    `check-in job filter must accept scheduled cron ${cron}`,
  );
}

assert.match(workflow, /workflow_dispatch:/, "manual dispatch must remain available");
console.log(`Daily schedule OK: ${expectedCrons.join(", ")}`);
