import assert from "node:assert/strict";
import test from "node:test";
import { calculateStaggerMs } from "./stagger-delay.mjs";

test("first matrix position starts immediately", () => {
  assert.equal(calculateStaggerMs(1, 12345), 0);
});

test("stagger is deterministic and uses inclusive 5–15 second gaps", () => {
  const first = calculateStaggerMs(8, 12345);
  const second = calculateStaggerMs(8, 12345);
  assert.equal(first, second);
  assert.ok(first >= 7 * 5_000);
  assert.ok(first <= 7 * 15_000);
});

test("invalid positions and ranges are rejected", () => {
  assert.throws(() => calculateStaggerMs(0, 1), /positive integer/);
  assert.throws(() => calculateStaggerMs(1, 1, { minSeconds: 10, maxSeconds: 5 }), /stagger range/);
});
