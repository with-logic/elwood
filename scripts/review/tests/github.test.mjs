/** Tests API boundaries for the review gate and exact-commit approval posting. */
import assert from "node:assert/strict";
import test from "node:test";
import { gate } from "../gate.mjs";
import { post } from "../post.mjs";
import { fixture, report } from "./github-fixture.mjs";
import { reportFixture } from "./report-fixture.mjs";

test("gate exports current commits only for eligible authors", async () => {
  const f = fixture();
  await gate(f);
  assert.deepEqual(f.outputs, { should: "true", number: "10", head: "head", base: "base" });
  f.state.permission = "read";
  await gate(f);
  assert.equal(f.outputs.should, "false");
});

test("gate refuses repeated rounds, but ignores other bots' review-shaped text", async () => {
  const f = fixture();
  f.state.reviews = Array.from({ length: 4 }, () => ({
    user: { login: "stranger" },
    body: "<!-- elwood:review -->",
    state: "COMMENT",
  }));
  await gate(f);
  assert.equal(f.outputs.should, "true");
  for (const review of f.state.reviews) review.user.login = "github-actions[bot]";
  await gate(f);
  assert.equal(f.outputs.should, "false");
  assert.equal(f.failures.length, 1);
});

test("old-commit approval does not skip review of a new commit", async () => {
  const f = fixture();
  f.state.reviews = [
    {
      user: { login: "github-actions[bot]" },
      body: "<!-- elwood:review -->",
      state: "APPROVED",
      commit_id: "old",
    },
  ];
  await gate(f);
  assert.equal(f.outputs.should, "true");
  f.state.reviews[0].commit_id = "head";
  await gate(f);
  assert.equal(f.outputs.should, "false");
});

test("dismissed clean approvals do not consume the non-converging round cap", async () => {
  const f = fixture();
  f.state.reviews = Array.from({ length: 4 }, () => ({
    user: { login: "github-actions[bot]" },
    body: `<!-- elwood:review -->\n${reportFixture()}`,
    state: "DISMISSED",
    commit_id: "old",
  }));
  await gate(f);
  assert.equal(f.outputs.should, "true");
  assert.deepEqual(f.failures, []);
});

test("dismissed non-approving reports still consume the round cap", async () => {
  for (const body of [
    "Verdict: not ready - 0 blocker(s), 1 major(s), 0 minor(s), 0 nit(s)",
    "The reviewer did not finish.",
  ]) {
    const f = fixture();
    f.state.reviews = Array.from({ length: 4 }, () => ({
      user: { login: "github-actions[bot]" },
      body: `<!-- elwood:review -->\n${body}`,
      state: "DISMISSED",
    }));
    await gate(f);
    assert.equal(f.outputs.should, "false");
    assert.equal(f.failures.length, 1);
  }
});

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

test("publication dismisses its own stale verdict after a concurrent push", async (t) => {
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
      f.pr.base.ref = "other";
    },
    (f) => {
      f.pr.head.repo.full_name = "other/elwood";
    },
  ]) {
    const f = fixture();
    const reportPath = await report(t);
    const dismissed = [];
    f.github.rest.pulls.createReview = (review) => {
      f.posted.push(review);
      alter(f);
      return { data: { id: 123 } };
    };
    f.github.rest.pulls.dismissReview = (request) => dismissed.push(request);
    await post({ ...f, reportPath });
    assert.equal(dismissed[0].review_id, 123);
    assert.match(f.outputs.notice, /superseded/);
  }
});

test("dismissal failure surfaces rather than claiming a stale verdict was neutralized", async (t) => {
  const f = fixture();
  const reportPath = await report(t);
  f.github.rest.pulls.createReview = () => {
    f.pr.head.sha = "new-head";
    return { data: { id: 123 } };
  };
  f.github.rest.pulls.dismissReview = () => {
    throw new Error("dismissal refused");
  };
  await assert.rejects(post({ ...f, reportPath }), /dismissal refused/);
});
