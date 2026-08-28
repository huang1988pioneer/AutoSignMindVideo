import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const summaryScript = fileURLToPath(new URL("./summarize-checkin-results.js", import.meta.url));

test("summary filters removed slots even when old results only contain a token name", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindvideo-summary-"));
  const inputDir = path.join(tempRoot, "collected");
  const outputDir = path.join(tempRoot, "artifacts");
  fs.mkdirSync(inputDir, { recursive: true });

  try {
    fs.writeFileSync(
      path.join(inputDir, "results.json"),
      `${JSON.stringify([
        { name: "MINDVIDEO_TOKEN12", status: "failed", message: "removed account" },
        { account: 13, name: "MINDVIDEO_TOKEN13", status: "failed", message: "removed account" },
        {
          name: "MINDVIDEO_TOKEN4",
          label: "feng33feng35feng3",
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
    assert.match(output, /#4/);
    assert.doesNotMatch(output, /#12|#13|removed account/);
    assert.ok(fs.existsSync(path.join(outputDir, "checkin-daily-summary.json")));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
