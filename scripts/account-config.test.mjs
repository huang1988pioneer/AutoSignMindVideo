import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkflowMatrix,
  loadAccountConfig,
  normalizeAccountConfig,
} from "./account-config.mjs";

test("repository account catalog keeps slots 1-7 and disables slots 8-33", () => {
  const config = loadAccountConfig();
  assert.equal(config.slotCount, 33);
  assert.equal(config.accounts.length, 7);
  assert.deepEqual(
    config.accounts.map((account) => account.number),
    [1, 2, 3, 4, 5, 6, 7],
  );
  for (const removed of [8, 9, 10, 11, 12, 13, ...Array.from({ length: 20 }, (_, index) => index + 14)]) {
    assert.equal(config.accounts.some((account) => account.number === removed), false);
  }
  assert.deepEqual(
    config.accounts.slice(0, 7).map((account) => [account.number, account.label]),
    [
      [1, "feng33feng35feng3"],
      [2, "huang1988pioneer"],
      [3, "chbondg_outloook"],
      [4, "gaokaolevel3iptopscorer_outlook"],
      [5, "huang1988pioneer_outlook"],
      [6, "fengtuta_tuta"],
      [7, "fengfence_fence"],
    ],
  );
  assert.deepEqual(config.accounts.slice(7), []);
  assert.equal(
    config.accounts.some((account) => /fengtuprinfo|fengwithfeng1127|tushenbyfengbro|samafengtu|fengtusama|fengwithting0831|fengwithtu1127|akaonda333|fbussinesseng|engdictatorf|flottojackpoteng|account-(?:1[4-9]|2[0-9])/i.test(account.label)),
    false,
  );
});

test("workflow positions follow catalog order after removals", () => {
  const matrix = buildWorkflowMatrix(loadAccountConfig());
  assert.equal(matrix.include.length, 7);
  assert.deepEqual(
    matrix.include.map((entry) => [entry.account, entry.position]),
    [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7]],
  );
});

test("legacy numeric account files remain readable during migration", () => {
  const config = normalizeAccountConfig({ "1": "alpha", "3": "gamma" }, "legacy.json");
  assert.equal(config.slotCount, 33);
  assert.deepEqual(config.accounts.map((account) => account.label), ["alpha", "gamma"]);
});

test("shared labels retain distinct workflow slots", () => {
  const config = normalizeAccountConfig({ accounts: [
    { number: 2, label: "huang1988pioneer" },
    { number: 32, label: "huang1988pioneer" },
  ] });
  assert.deepEqual(buildWorkflowMatrix(config).include, [
    { account: 2, label: "huang1988pioneer", position: 1 },
    { account: 32, label: "huang1988pioneer", position: 2 },
  ]);
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
