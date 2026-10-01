/** Preserved exact-commit approvals still report failed publication validation (PRD §16). */
import assert from "node:assert/strict";
import test from "node:test";
import { post } from "../post.mjs";
import { fixture, report } from "./github-fixture.mjs";

for (const scenario of ["head", "base", "permission", "draft", "closed", "failing reread"]) {
  test(`C-REVIEW-04 preserves approval but fails changed publication (${scenario})`, async (t) => {
    const f = fixture();
    const reportPath = await report(t);
    const original = new Error("GitHub unavailable");
    const dismissed = [];
    let reads = 0;
    f.github.rest.pulls.get = () => {
      if (++reads === 2 && scenario === "failing reread") throw original;
      return { data: f.pr };
    };
    f.github.rest.pulls.createReview = (review) => {
      f.posted.push(review);
      if (scenario === "head" || scenario === "base") f.pr[scenario].sha = "new";
      if (scenario === "permission") f.state.permission = "read";
      if (scenario === "draft") f.pr.draft = true;
      if (scenario === "closed") f.pr.state = "closed";
      return { data: { id: 123 } };
    };
    f.github.rest.pulls.dismissReview = (request) => dismissed.push(request);
    await assert.rejects(post({ ...f, reportPath }), (error) =>
      scenario === "failing reread" ? error === original : /remains recorded/.test(error.message),
    );
    assert.equal(f.posted.length, 1);
    assert.equal(f.posted[0].event, "APPROVE");
    assert.equal(f.posted[0].commit_id, "head");
    assert.equal(reads, 2, "accepted approval is still revalidated");
    assert.deepEqual(dismissed, []);
    assert.equal(f.outputs.info, undefined, "changed publication cannot report success");
    if (scenario === "failing reread") assert.match(f.outputs.notice, /remains recorded/);
  });
}

test("C-REVIEW-04 failed approval submission preserves its original error", async (t) => {
  const f = fixture();
  const reportPath = await report(t);
  const original = new Error("Submission failed");
  f.github.rest.pulls.createReview = () => {
    throw original;
  };
  await assert.rejects(post({ ...f, reportPath }), (error) => error === original);
  assert.equal(f.outputs.info, undefined);
});
