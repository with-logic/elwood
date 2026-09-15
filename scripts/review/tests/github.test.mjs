/** Tests API boundaries for the review gate and exact-commit approval posting. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gate } from "../gate.mjs";
import { post } from "../post.mjs";

function fixture() {
  const outputs = {};
  const posted = [];
  const failures = [];
  const pr = {
    number: 10,
    state: "open",
    draft: false,
    user: { login: "maintainer", type: "User" },
    head: { sha: "head", repo: { full_name: "with-logic/elwood" } },
    base: { ref: "main", sha: "base" },
  };
  const state = { permission: "write", reviews: [] };
  const github = {
    rest: {
      pulls: {
        get() {
          return { data: pr };
        },
        listReviews: "listReviews",
        createReview(review) {
          posted.push(review);
        },
      },
      repos: {
        getCollaboratorPermissionLevel() {
          return { data: { permission: state.permission } };
        },
      },
    },
    paginate() {
      return state.reviews;
    },
  };
  const core = {
    setOutput(key, value) {
      outputs[key] = value;
    },
    setFailed(message) {
      failures.push(message);
    },
    notice(message) {
      outputs.notice = message;
    },
    info(message) {
      outputs.info = message;
    },
  };
  return {
    github,
    core,
    context: { repo: { owner: "with-logic", repo: "elwood" } },
    number: "10",
    head: "head",
    base: "base",
    complete: true,
    outputs,
    posted,
    failures,
    pr,
    state,
  };
}

async function report(t) {
  const dir = await mkdtemp(join(tmpdir(), "elwood-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "REVIEW.md");
  await writeFile(path, "# Review\nVerdict: clean, no notes\n");
  return path;
}

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
    body: "<!-- elwood:review -->\n# Review\nVerdict: clean, no notes\n",
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
