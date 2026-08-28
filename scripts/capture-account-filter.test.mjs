import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const captureScript = fileURLToPath(new URL("./capture-token-gui.mjs", import.meta.url));

test("GUI token capture rejects a non-catalog account before launching Playwright", () => {
  const result = spawnSync(process.execPath, [captureScript, "--account", "34"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /Account #34 is disabled or missing in accounts\.json/);
});
