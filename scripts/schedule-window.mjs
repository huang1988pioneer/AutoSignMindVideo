import fs from "node:fs";

/** First Asia/Taipei calendar day on which automatic check-in does not run. */
export const AUTOMATIC_CHECKIN_ENDS_ON = "2026-11-26";

export function taipeiDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** True while the Taipei date is still before the automatic cutoff. */
export function isAutomaticCheckinOpen(now = new Date(), endsOn = AUTOMATIC_CHECKIN_ENDS_ON) {
  return taipeiDate(now) < endsOn;
}

export function isScheduledCheckin(env = process.env) {
  return env.GITHUB_EVENT_NAME === "schedule" || env.MINDVIDEO_SCHEDULED === "1";
}

function resolveNow(env = process.env) {
  if (!env.GITHUB_ACTIONS && env.MINDVIDEO_NOW) return new Date(env.MINDVIDEO_NOW);
  return new Date();
}

/**
 * Scheduled runs stop on the cutoff. Manual workflow_dispatch stays available.
 * Returns whether this run should check in.
 */
export function shouldCheckIn(env = process.env, now = resolveNow(env)) {
  if (!isScheduledCheckin(env)) return true;
  return isAutomaticCheckinOpen(now);
}

function writeGitHubOutput(env, active) {
  if (!env.GITHUB_OUTPUT) return;
  fs.appendFileSync(env.GITHUB_OUTPUT, `active=${active ? "true" : "false"}\n`);
}

function explain(active, now) {
  const today = taipeiDate(now);
  if (active) return `Automatic check-in is open (Asia/Taipei ${today}).`;
  return `Automatic check-in stopped on ${AUTOMATIC_CHECKIN_ENDS_ON} (Asia/Taipei ${today}).`;
}

if (process.argv[1]?.endsWith("schedule-window.mjs")) {
  const now = resolveNow();
  const active = shouldCheckIn(process.env, now);
  writeGitHubOutput(process.env, active);
  console.log(explain(active, now));
}
