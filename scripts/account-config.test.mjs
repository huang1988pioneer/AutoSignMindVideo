import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkflowMatrix,
  loadAccountConfig,
  normalizeAccountConfig,
} from "./account-config.mjs";

test("repository account catalog keeps stable slots and excludes retired accounts", () => {
  const config = loadAccountConfig();
  assert.equal(config.slotCount, 33);
  assert.equal(config.accounts.length, 25);
  assert.deepEqual(
    config.accounts.map((account) => account.number),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33],
  );
  for (const retired of [12, 13, 14, 16, 17, 18, 19, 20]) {
    assert.equal(config.accounts.some((account) => account.number === retired), false);
  }
  assert.equal(config.accounts.some((account) => /samafengtu|fengtusama|akaonda333/i.test(account.label)), false);
});

test("workflow positions are contiguous even when Secret slots have gaps", () => {
  const matrix = buildWorkflowMatrix(loadAccountConfig());
  assert.equal(matrix.include.length, 25);
  assert.deepEqual(
    matrix.include.slice(9, 13).map((entry) => [entry.account, entry.position]),
    [[10, 10], [11, 11], [15, 12], [21, 13]],
  );
});

test("legacy numeric account files remain readable during migration", () => {
  const config = normalizeAccountConfig({ "1": "alpha", "3": "gamma" }, "legacy.json");
  assert.equal(config.slotCount, 33);
  assert.deepEqual(config.accounts.map((account) => account.label), ["alpha", "gamma"]);
});

test("invalid account catalogs fail early", () => {
  assert.throws(
    () => normalizeAccountConfig({ slotCount: 2, accounts: [{ number: 1, label: "a" }, { number: 1, label: "b" }] }, "test.json"),
    /duplicate account number/,
  );
  assert.throws(
    () => normalizeAccountConfig({ slotCount: 1, accounts: [{ number: 2, label: "a" }] }, "test.json"),
    /slotCount.*highest account number/,
  );
});
