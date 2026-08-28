import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const summaryScript = fileURLToPath(new URL("./summarize-checkin-results.js", import.meta.url));

test("summary filters retired slots even when old results only contain a token name", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindvideo-summary-"));
  const inputDir = path.join(tempRoot, "collected");
  const outputDir = path.join(tempRoot, "artifacts");
  fs.mkdirSync(inputDir, { recursive: true });

  try {
    fs.writeFileSync(
      path.join(inputDir, "results.json"),
      `${JSON.stringify([
        { name: "MINDVIDEO_TOKEN14", status: "failed", message: "retired account" },
        { account: 15, name: "MINDVIDEO_TOKEN15", status: "failed", message: "retired account" },
        {
          name: "MINDVIDEO_TOKEN1",
          label: "goldshoot0720",
          status: "already_done",
          streak: 3,
          totalCredits: 100,
        },
      ])}\n`,
      "utf8",
    );

    const result = spawnSync(process.execPath, [summaryScript, inputDir], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MINDVIDEO_SUMMARY_DIR: outputDir,
        MINDVIDEO_EXPECTED_ACCOUNTS: "1",
      },
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /#1/);
    assert.doesNotMatch(output, /#14|#15|retired account/);
    assert.ok(fs.existsSync(path.join(outputDir, "checkin-daily-summary.json")));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
