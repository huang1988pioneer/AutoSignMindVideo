import fs from "node:fs";
import path from "node:path";

const account = Number(process.env.MINDVIDEO_ACCOUNT);
if (!Number.isInteger(account) || account < 1) {
  throw new Error("MINDVIDEO_ACCOUNT must be a positive integer when writing a fallback result");
}

const status = process.env.MINDVIDEO_RESULT_STATUS || "failed";
const message = process.env.MINDVIDEO_RESULT_MESSAGE || "check-in did not write a result artifact";
const outputDirectory = process.env.MINDVIDEO_RESULT_DIR || path.join(process.cwd(), "artifacts");
const row = {
  account,
  name: process.env.MINDVIDEO_SECRET_NAME || `MINDVIDEO_TOKEN${account}`,
  label: process.env.MINDVIDEO_ACCOUNT_LABEL || null,
  status,
  message,
  creditsDelta: null,
  totalCredits: null,
  streak: null,
  dailyReward: null,
  finishedAt: new Date().toISOString(),
  runId: process.env.GITHUB_RUN_ID || null,
  job: process.env.GITHUB_JOB || null,
};

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(
  path.join(outputDirectory, "checkin-result.json"),
  `${JSON.stringify(row, null, 2)}\n`,
  "utf8",
);
