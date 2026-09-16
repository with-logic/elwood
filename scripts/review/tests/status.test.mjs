/** Tests review visibility and preservation of existing approval; PRD §16. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { post } from "../post.mjs";
import { reportFailure } from "../status.mjs";
import { fixture, report } from "./github-fixture.mjs";
import { findingFixture, reportFixture } from "./report-fixture.mjs";

test("C-REVIEW-04 an existing approval retains non-approving findings as comments", async (t) => {
  const f = fixture();
  f.github.graphql = () => ({ repository: { pullRequest: { reviewDecision: "APPROVED" } } });
  const reportPath = await report(t);
  await writeFile(reportPath, reportFixture({ "review-security": findingFixture("major") }));
  await post({ ...f, reportPath });
  assert.equal(f.posted[0].event, "COMMENT");
});

test("C-REVIEW-04 published reports include the run link and rerun command", async (t) => {
  const f = fixture();
  const reportPath = await report(t);
  const runUrl = "https://github.com/with-logic/elwood/actions/runs/123";
  await post({ ...f, reportPath, runUrl });
  assert.ok(f.posted[0].body.includes(runUrl));
  assert.ok(f.posted[0].body.includes("/elwood review"));
});

test("C-REVIEW-04 unapproved PRs retain change requests; failed decision reads cannot post", async (t) => {
  const f = fixture();
  const reportPath = await report(t);
  await writeFile(reportPath, reportFixture({ "review-security": findingFixture("major") }));
  await post({ ...f, reportPath });
  assert.equal(f.posted[0].event, "REQUEST_CHANGES");
  f.github.graphql = () => {
    throw new Error("decision unavailable");
  };
  await assert.rejects(post({ ...f, reportPath }), /decision unavailable/);
  assert.equal(f.posted.length, 1);
});

test("C-REVIEW-04 failures and cancellation are visible without granting approval", async () => {
  const f = fixture();
  const comments = [];
  f.github.rest.issues = { createComment: (body) => comments.push(body) };
  const runUrl = "https://github.com/with-logic/elwood/actions/runs/123";
  await reportFailure({ ...f, runUrl, result: "failure" });
  assert.match(comments[0].body, /did not finish successfully/);
  assert.ok(comments[0].body.includes(runUrl));
  await reportFailure({ ...f, runUrl, result: "cancelled" });
  assert.match(comments[1].body, /was canceled/);
  assert.ok(comments[1].body.includes("/elwood review"));
  assert.equal(f.posted.length, 0);
  f.pr.head.sha = "new";
  await reportFailure({ ...f, runUrl, result: "failure" });
  assert.equal(comments.length, 2);
  f.pr.head.sha = "head";
  f.state.permission = "read";
  await reportFailure({ ...f, runUrl, result: "failure" });
  assert.equal(comments.length, 2);
});
