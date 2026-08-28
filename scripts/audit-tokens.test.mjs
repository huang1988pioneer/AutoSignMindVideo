import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicateTokens } from "./audit-tokens.mjs";
import { loadAccountConfig } from "./account-config.mjs";

test("token audit only considers enabled account slots", () => {
  const config = loadAccountConfig();
  const duplicates = findDuplicateTokens(
    {
      MINDVIDEO_TOKEN1: "same-token",
      MINDVIDEO_TOKEN12: "same-token",
      MINDVIDEO_TOKEN15: "same-token",
      MINDVIDEO_TOKEN13: "retired-only",
    },
    config,
  );
  assert.deepEqual(duplicates, [["MINDVIDEO_TOKEN1", "MINDVIDEO_TOKEN15"]]);
});

test("empty token values are ignored", () => {
  assert.deepEqual(findDuplicateTokens({ MINDVIDEO_TOKEN1: " ", MINDVIDEO_TOKEN15: "" }, loadAccountConfig()), []);
});
