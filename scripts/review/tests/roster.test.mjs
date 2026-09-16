/** Pins the promised eleven dimensions independently of generated report fixtures. */
import assert from "node:assert/strict";
import test from "node:test";
import { lenses } from "../report.mjs";

test("the production roster preserves every promised dimension", () => {
  assert.deepEqual([...lenses].sort(), [
    "review-architecture-conventions",
    "review-clarity",
    "review-concurrency",
    "review-database",
    "review-error-handling",
    "review-naming",
    "review-observability",
    "review-performance",
    "review-security",
    "review-testing",
    "review-type-safety",
  ]);
});
