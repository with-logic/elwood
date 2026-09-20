/** Tests API boundaries for exact-commit approval posting; PRD §16. */
import assert from "node:assert/strict";
import test from "node:test";
import { post } from "../post.mjs";
import { fixture, report } from "./github-fixture.mjs";
import { findingFixture, reportFixture } from "./report-fixture.mjs";

const changes = reportFixture(
  { "review-security": findingFixture("major") },
  "Verdict: not ready - 0 blocker(s), 1 major(s), 0 minor(s), 0 nit(s)",
);

test("posting rechecks permissions, state, and both commits", async (t) => {
  const reportPath = await report(t);
  for (const alter of [
    (f) => {
      f.pr.head.sha = "new";
    },
    (f) => {
      f.pr.base.sha = "new";
    },
    (f) => {
      f.pr.state = "closed";
    },
    (f) => {
      f.state.permission = "read";
    },
    (f) => {
      f.pr.head.repo.full_name = "stranger/elwood";
    },
  ]) {
    const f = fixture();
    alter(f);
    await post({ ...f, reportPath });
    assert.equal(f.posted.length, 0);
  }
});

test("only completed clean reviews approve, attached to the reviewed commit", async (t) => {
  const f = fixture();
  const reportPath = await report(t);
  await post({ ...f, reportPath });
  assert.equal(f.posted[0].event, "APPROVE");
  assert.equal(f.posted[0].commit_id, "head");
  await post({ ...f, reportPath, complete: false });
  assert.equal(f.posted[1].event, "COMMENT");
});

test("publication dismisses its own stale request for changes after a concurrent push", async (t) => {
  for (const alter of [
    (f) => {
      f.pr.head.sha = "new";
    },
    (f) => {
      f.pr.base.sha = "new";
    },
    (f) => {
      f.state.permission = "read";
    },
    (f) => {
      f.pr.draft = true;
    },
    (f) => {
      f.pr.state = "closed";
    },
    (f) => {
      // A cross-repository base, not merely a non-`main` one: since §16 now admits any
      // same-repository base so stacked PRs are reviewed, `base.ref` alone no longer
      // makes a PR ineligible, but a base in another repository still does.
      f.pr.base.repo.full_name = "other/elwood";
    },
    (f) => {
      f.pr.head.repo.full_name = "other/elwood";
    },
  ]) {
    const f = fixture();
    const reportPath = await report(t, changes);
    const dismissed = [];
    f.github.rest.pulls.createReview = (review) => {
      f.posted.push(review);
      alter(f);
      return { data: { id: 123 } };
    };
    f.github.rest.pulls.dismissReview = (request) => dismissed.push(request);
    await post({ ...f, reportPath });
    assert.equal(f.posted[0].event, "REQUEST_CHANGES");
    assert.equal(dismissed[0].review_id, 123);
    assert.match(f.outputs.notice, /superseded/);
  }
});

test("dismissal failure surfaces rather than claiming a stale verdict was neutralized", async (t) => {
  const f = fixture();
  const reportPath = await report(t, changes);
  f.github.rest.pulls.createReview = () => {
    f.pr.head.sha = "new-head";
    return { data: { id: 123 } };
  };
  f.github.rest.pulls.dismissReview = () => {
    throw new Error("dismissal refused");
  };
  await assert.rejects(post({ ...f, reportPath }), /dismissal refused/);
});
