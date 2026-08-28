import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicateTokens } from "./audit-tokens.mjs";
import { loadAccountConfig } from "./account-config.mjs";

test("token audit follows the active account catalog and ignores removed slots", () => {
  const config = loadAccountConfig();
  const duplicates = findDuplicateTokens(
    {
      MINDVIDEO_TOKEN1: "same-token",
      MINDVIDEO_TOKEN4: "same-token",
      MINDVIDEO_TOKEN6: "same-token",
      MINDVIDEO_TOKEN30: "placeholder-token",
      MINDVIDEO_TOKEN31: "placeholder-token",
      MINDVIDEO_TOKEN12: "same-token",
    },
    config,
  );
  assert.deepEqual(duplicates, [
    ["MINDVIDEO_TOKEN4", "MINDVIDEO_TOKEN6"],
    ["MINDVIDEO_TOKEN30", "MINDVIDEO_TOKEN31"],
  ]);
});

test("empty token values are ignored", () => {
  assert.deepEqual(findDuplicateTokens({ MINDVIDEO_TOKEN1: " ", MINDVIDEO_TOKEN12: "", MINDVIDEO_TOKEN34: "same-token" }, loadAccountConfig()), []);
});
