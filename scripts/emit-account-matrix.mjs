import fs from "node:fs";
import { buildWorkflowMatrix, loadAccountConfig } from "./account-config.mjs";

const config = loadAccountConfig();
const matrix = JSON.stringify(buildWorkflowMatrix(config));
const outputs = {
  matrix,
  count: String(config.accounts.length),
  slot_count: String(config.slotCount),
  max_parallel: String(config.accounts.length),
};

if (process.env.GITHUB_OUTPUT) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, "utf8");
} else {
  for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
}
