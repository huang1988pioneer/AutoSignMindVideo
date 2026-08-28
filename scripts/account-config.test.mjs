import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkflowMatrix,
  loadAccountConfig,
  normalizeAccountConfig,
} from "./account-config.mjs";

test("repository account catalog includes restored accounts and placeholder slots", () => {
  const config = loadAccountConfig();
  assert.equal(config.slotCount, 33);
  assert.equal(config.accounts.length, 33);
  assert.deepEqual(
    config.accounts.map((account) => account.number),
    Array.from({ length: 33 }, (_, index) => index + 1),
  );
  assert.equal(config.accounts.find((account) => account.number === 12)?.label, "fengwithfeng1127");
  assert.equal(config.accounts.find((account) => account.number === 13)?.label, "flottojackpoteng");
  assert.deepEqual(
    config.accounts.slice(13, 20).map((account) => [account.number, account.label]),
    [[14, "account-14"], [15, "account-15"], [16, "account-16"], [17, "account-17"], [18, "account-18"], [19, "account-19"], [20, "account-20"]],
  );
  assert.equal(
    config.accounts.some((account) => /samafengtu|fengtusama|fengwithting0831|fengwithtu1127|akaonda333|fbussinesseng|engdictatorf/i.test(account.label)),
    false,
  );
});

test("workflow positions follow catalog order", () => {
  const matrix = buildWorkflowMatrix(loadAccountConfig());
  assert.equal(matrix.include.length, 33);
  assert.deepEqual(
    matrix.include.slice(9, 21).map((entry) => [entry.account, entry.position]),
    [[10, 10], [11, 11], [12, 12], [13, 13], [14, 14], [15, 15], [16, 16], [17, 17], [18, 18], [19, 19], [20, 20], [21, 21]],
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
