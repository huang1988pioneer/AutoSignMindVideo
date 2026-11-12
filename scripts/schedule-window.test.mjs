import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AUTOMATIC_CHECKIN_ENDS_ON,
  isAutomaticCheckinOpen,
  shouldCheckIn,
  taipeiDate,
} from "./schedule-window.mjs";

const scriptPath = fileURLToPath(new URL("./schedule-window.mjs", import.meta.url));

test("automatic check-in stays open through 2026-11-25 Taipei and stops on 2026-11-26", () => {
  assert.equal(AUTOMATIC_CHECKIN_ENDS_ON, "2026-11-26");
  assert.equal(isAutomaticCheckinOpen(new Date("2026-11-25T13:09:00Z")), true);
  assert.equal(taipeiDate(new Date("2026-11-25T13:09:00Z")), "2026-11-25");
  assert.equal(isAutomaticCheckinOpen(new Date("2026-11-25T15:59:00Z")), true);
  assert.equal(isAutomaticCheckinOpen(new Date("2026-11-25T16:00:00Z")), false);
  assert.equal(taipeiDate(new Date("2026-11-25T16:00:00Z")), "2026-11-26");
  assert.equal(isAutomaticCheckinOpen(new Date("2026-11-25T21:09:00Z")), false);
});

test("manual runs stay available after the automatic cutoff", () => {
  const closed = new Date("2026-11-26T01:00:00+08:00");
  assert.equal(shouldCheckIn({ GITHUB_EVENT_NAME: "schedule" }, closed), false);
  assert.equal(shouldCheckIn({ MINDVIDEO_SCHEDULED: "1" }, closed), false);
  assert.equal(shouldCheckIn({ GITHUB_EVENT_NAME: "workflow_dispatch" }, closed), true);
  assert.equal(shouldCheckIn({}, closed), true);
});

test("schedule window writes active=false for a scheduled run on the cutoff date", () => {
  const output = path.join(os.tmpdir(), `mindvideo-window-${process.pid}.txt`);
  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "",
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_OUTPUT: output,
        MINDVIDEO_NOW: "2026-11-26T05:09:00+08:00",
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /stopped on 2026-11-26/);
    assert.equal(fs.readFileSync(output, "utf8").trim(), "active=false");
  } finally {
    fs.rmSync(output, { force: true });
  }
});
