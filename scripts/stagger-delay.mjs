import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MIN_SECONDS = 5;
const DEFAULT_MAX_SECONDS = 15;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeSeed(seed) {
  const value = Number(seed);
  return Number.isFinite(value) ? value >>> 0 : Date.now() >>> 0;
}

export function calculateStaggerMs(position, seed, options = {}) {
  if (!Number.isInteger(position) || position < 1) {
    throw new Error(`stagger position must be a positive integer: ${position}`);
  }
  const minSeconds = options.minSeconds ?? DEFAULT_MIN_SECONDS;
  const maxSeconds = options.maxSeconds ?? DEFAULT_MAX_SECONDS;
  if (!Number.isInteger(minSeconds) || !Number.isInteger(maxSeconds) || minSeconds < 0 || maxSeconds < minSeconds) {
    throw new Error("stagger range must contain non-negative integer seconds");
  }

  const random = mulberry32(normalizeSeed(seed));
  let milliseconds = 0;
  for (let index = 1; index < position; index += 1) {
    const seconds = minSeconds + Math.floor(random() * (maxSeconds - minSeconds + 1));
    milliseconds += seconds * 1000;
  }
  return milliseconds;
}

function runCli() {
  const position = Number(process.env.MINDVIDEO_STAGGER_INDEX || 1);
  const seed = normalizeSeed(process.env.GITHUB_RUN_ID || Date.now());
  const milliseconds = calculateStaggerMs(position, seed);
  process.stderr.write(
    `Stagger plan: position #${position} waits ${milliseconds}ms (seed=${seed})\n`,
  );
  process.stdout.write(String(milliseconds));
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) runCli();
