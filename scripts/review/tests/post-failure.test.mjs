/** Verifies cleanup retains the original API failure after a review has been submitted. */
import assert from "node:assert/strict";
import test from "node:test";
import { post } from "../post.mjs";
import { fixture, report } from "./github-fixture.mjs";
import { findingFixture, reportFixture } from "./report-fixture.mjs";

const changes = reportFixture(
  { "review-security": findingFixture("major") },
  "Verdict: not ready - 0 blocker(s), 1 major(s), 0 minor(s), 0 nit(s)",
);

test("a revalidation API failure dismisses a request for changes and preserves the error", async (t) => {
  for (const complete of [true, false]) {
    const f = fixture();
    const reportPath = await report(t, changes);
    const original = new Error("GitHub temporarily unavailable");
    let gets = 0;
    const dismissed = [];
    f.github.rest.pulls.get = () => {
      if (++gets === 2) throw original;
      return { data: f.pr };
    };
    f.github.rest.pulls.dismissReview = (args) => dismissed.push(args);
    await assert.rejects(post({ ...f, reportPath, complete }), (error) => error === original);
    assert.equal(dismissed.length, complete ? 1 : 0);
    if (complete) assert.equal(dismissed[0].review_id, 123);
  }
});

test("a failed cleanup reports both errors with the revalidation error as its cause", async (t) => {
  const f = fixture();
  const reportPath = await report(t, changes);
  const original = new Error("GitHub temporarily unavailable");
  const cleanup = new Error("Dismissal refused");
  let gets = 0;
  f.github.rest.pulls.get = () => {
    if (++gets === 2) throw original;
    return { data: f.pr };
  };
  f.github.rest.pulls.dismissReview = () => {
    throw cleanup;
  };
  await assert.rejects(post({ ...f, reportPath }), (error) => {
    assert.equal(error.cause, original);
    assert.deepEqual(error.errors, [original, cleanup]);
    return true;
  });
});
