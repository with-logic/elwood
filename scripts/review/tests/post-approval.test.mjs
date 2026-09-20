/** Published approvals survive later races and API failures (PRD §16). */
import assert from "node:assert/strict";
import test from "node:test";
import { post } from "../post.mjs";
import { fixture, report } from "./github-fixture.mjs";

for (const change of ["head", "base", "permission", "api failure"]) {
  test(`C-REVIEW-04 published approval survives a subsequent ${change} change`, async (t) => {
    const f = fixture();
    const reportPath = await report(t);
    const dismissed = [];
    let reads = 0;
    f.github.rest.pulls.get = () => {
      reads += 1;
      if (reads > 1 && change === "api failure") throw new Error("GitHub unavailable");
      return { data: f.pr };
    };
    f.github.rest.pulls.createReview = (review) => {
      f.posted.push(review);
      if (change === "head" || change === "base") f.pr[change].sha = "new";
      if (change === "permission") f.state.permission = "read";
      return { data: { id: 123 } };
    };
    f.github.rest.pulls.dismissReview = (request) => dismissed.push(request);
    await post({ ...f, reportPath });
    assert.equal(f.posted.length, 1);
    assert.equal(f.posted[0].event, "APPROVE");
    assert.equal(f.posted[0].commit_id, "head");
    assert.equal(reads, 1, "a posted approval is not revalidated");
    assert.deepEqual(dismissed, []);
    assert.equal(f.outputs.info, "Submitted APPROVE for head");
  });
}

test("C-REVIEW-04 failed approval submission still fails visibly", async (t) => {
  const f = fixture();
  const reportPath = await report(t);
  const error = new Error("Submission failed");
  f.github.rest.pulls.createReview = () => {
    throw error;
  };
  await assert.rejects(post({ ...f, reportPath }), (actual) => actual === error);
  assert.equal(f.outputs.info, undefined);
});
