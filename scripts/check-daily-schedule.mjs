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

const workflowLines = workflow.split(/\r?\n/);
const heredocStarts = workflowLines
  .map((line, index) => ({ line, index }))
  .filter(({ line }) => line.includes("<<'NODE'"));

for (const { index: start } of heredocStarts) {
  const end = workflowLines.findIndex(
    (line, index) => index > start && line.trim() === "NODE",
  );
  assert.ok(end > start, "every Node heredoc must have a closing NODE marker");

  const unindented = workflowLines
    .slice(start + 1, end)
    .filter((line) => line.trim() && !/^ {10,}\S/.test(line));
  assert.deepEqual(
    unindented,
    [],
    "Node heredoc bodies must remain inside the workflow run block",
  );
}

for (const cron of expectedCrons) {
  assert.ok(
    workflow.includes(`github.event.schedule == '${cron}'`),
    `check-in job filter must accept scheduled cron ${cron}`,
  );
}

assert.match(workflow, /workflow_dispatch:/, "manual dispatch must remain available");
console.log(`Daily schedule OK: ${expectedCrons.join(", ")}`);
