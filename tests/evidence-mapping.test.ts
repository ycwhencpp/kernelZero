import assert from "node:assert/strict";
import test from "node:test";
import { podcastClaimSourceIndex } from "../lib/podcast-schema";

test("explicit claim ownership survives consolidation reordering", () => {
  assert.equal(podcastClaimSourceIndex({ sourceNumber: 3 }, 0, 3), 2);
  assert.equal(podcastClaimSourceIndex({ sourceNumber: 1 }, 1, 3), 0);
  assert.equal(podcastClaimSourceIndex({ sourceNumber: 2 }, 2, 3), 1);
});

test("legacy claims retain position-based source attribution", () => {
  assert.equal(podcastClaimSourceIndex({}, 0, 2), 0);
  assert.equal(podcastClaimSourceIndex({}, 8, 2), 1);
});
