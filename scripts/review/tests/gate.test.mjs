/** Tests one automatic report and repeatable, authorized manual reviews; PRD §16. */
import assert from "node:assert/strict";
import test from "node:test";
import { gate } from "../gate.mjs";
import { fixture } from "./github-fixture.mjs";

function request(eventName = "pull_request") {
  const f = fixture();
  f.context.eventName = eventName;
  f.context.payload = {
    action: "opened",
    pull_request: { number: 10 },
    issue: { number: 10, pull_request: {} },
    comment: { body: "/elwood review", user: { login: "requester", type: "User" } },
    sender: { login: "requester", type: "User" },
    inputs: { pr_number: "10" },
  };
  return f;
}

test("C-REVIEW-01 automatic review runs once, without reacting to pushes", async () => {
  const f = request();
  await gate(f);
  assert.equal(f.outputs.should, "true");
  f.state.reviews = [{ user: { login: "stranger" }, body: "<!-- elwood:review -->" }];
  await gate(f);
  assert.equal(f.outputs.should, "true");
  f.state.reviews[0].user.login = "github-actions[bot]";
  for (const state of ["APPROVED", "DISMISSED", "COMMENT", "CHANGES_REQUESTED"]) {
    f.state.reviews[0].state = state;
    await gate(f);
    assert.equal(f.outputs.should, "false");
  }
  f.state.reviews = [];
  f.context.payload.action = "synchronize";
  await gate(f);
  assert.equal(f.outputs.should, "false");
  f.context.payload.action = "ready_for_review";
  await gate(f);
  assert.equal(f.outputs.should, "true");
});

test("C-REVIEW-02 manual requests have no round or current-approval limit", async () => {
  for (const event of ["issue_comment", "workflow_dispatch"]) {
    const f = request(event);
    f.context.payload.action = "created";
    f.state.reviews = Array.from({ length: 8 }, () => ({
      user: { login: "github-actions[bot]" },
      body: "<!-- elwood:review -->",
      state: "APPROVED",
      commit_id: "head",
    }));
    await gate(f);
    assert.equal(f.outputs.should, "true");
    assert.deepEqual(f.failures, []);
  }
});

test("C-REVIEW-03 only exact newly-created PR commands from current writers run", async () => {
  for (const mutate of [
    (f) => {
      f.context.payload.comment.body = "please /elwood review";
    },
    (f) => {
      f.context.payload.comment.body = "> /elwood review";
    },
    (f) => {
      f.context.payload.action = "edited";
    },
    (f) => {
      f.context.payload.issue.pull_request = undefined;
    },
    (f) => {
      f.context.payload.comment.user.type = "Bot";
    },
    (f) => {
      f.state.permission = "read";
    },
    (f) => {
      f.state.permission = "triage";
    },
  ]) {
    const f = request("issue_comment");
    f.context.payload.action = "created";
    mutate(f);
    await gate(f);
    assert.equal(f.outputs.should, "false");
  }
});

test("C-REVIEW-03 requester permission is checked separately from the PR author", async () => {
  const f = request("issue_comment");
  f.context.payload.action = "created";
  f.github.rest.repos.getCollaboratorPermissionLevel = ({ username }) => ({
    data: { permission: username === "requester" ? "read" : "admin" },
  });
  await gate(f);
  assert.equal(f.outputs.should, "false");
});

test("C-REVIEW-03 dispatch authorization fails closed and preserves PR eligibility", async () => {
  for (const permission of ["read", "triage", "none"]) {
    const f = request("workflow_dispatch");
    f.state.permission = permission;
    await gate(f);
    assert.equal(f.outputs.should, "false");
  }
  const f = request("workflow_dispatch");
  f.pr.draft = true;
  await gate(f);
  assert.equal(f.outputs.should, "false");
  f.pr.draft = false;
  await gate(f);
  assert.deepEqual(f.outputs, {
    should: "true",
    number: "10",
    head: "head",
    base: "base",
    notice:
      "Review skipped: only ready maintainer PRs whose head and base are both in this repository qualify.",
  });
  f.github.rest.repos.getCollaboratorPermissionLevel = () => {
    throw new Error("unavailable");
  };
  await assert.rejects(gate(f), /unavailable/);
  assert.equal(f.outputs.should, "false");
});
