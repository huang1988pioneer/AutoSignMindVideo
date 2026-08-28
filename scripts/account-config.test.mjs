import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkflowMatrix,
  loadAccountConfig,
  normalizeAccountConfig,
} from "./account-config.mjs";

test("repository account catalog excludes removed accounts and keeps placeholders", () => {
  const config = loadAccountConfig();
  assert.equal(config.slotCount, 33);
  assert.equal(config.accounts.length, 27);
  assert.deepEqual(
    config.accounts.map((account) => account.number),
    [4, 6, 7, 8, 9, 10, 11, ...Array.from({ length: 20 }, (_, index) => index + 14)],
  );
  for (const removed of [1, 2, 3, 5, 12, 13]) {
    assert.equal(config.accounts.some((account) => account.number === removed), false);
  }
  assert.deepEqual(
    config.accounts.slice(7).map((account) => [account.number, account.label]),
    Array.from({ length: 20 }, (_, index) => [index + 14, `account-${index + 14}`]),
  );
  assert.equal(
    config.accounts.some((account) => /goldshoot0720|abuhg17|fengtuprinfo|chbondg2|fengwithfeng1127|tushenbyfengbro|samafengtu|fengtusama|fengwithting0831|fengwithtu1127|akaonda333|fbussinesseng|engdictatorf|flottojackpoteng/i.test(account.label)),
    false,
  );
});

test("workflow positions follow catalog order after removals", () => {
  const matrix = buildWorkflowMatrix(loadAccountConfig());
  assert.equal(matrix.include.length, 27);
  assert.deepEqual(
    matrix.include.slice(5, 15).map((entry) => [entry.account, entry.position]),
    [[10, 6], [11, 7], [14, 8], [15, 9], [16, 10], [17, 11], [18, 12], [19, 13], [20, 14], [21, 15]],
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
