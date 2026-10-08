/** Checks the active shared review triggers and stacked-PR eligibility (§16). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(
  fileURLToPath(new URL("../../../.github/workflows/code-review.yml", import.meta.url)),
  "utf8",
);

test("C-REVIEW-05 the pull_request trigger does not filter by base branch", () => {
  // GitHub applies a `branches:` filter BEFORE the job runs, so a filter here drops the
  // event for a stacked PR and the live authorization gate never gets to judge it — the PR receives no
  // automatic review at all, silently. The repository boundary belongs in the live authorization gate,
  // which checks that head and base are both in this repository; it cannot be expressed
  // as a branch-name filter.
  const trigger = /\n {2}pull_request:\n((?: {4}.*\n|\n)*)/u.exec(workflow);
  assert.ok(trigger, "the workflow must keep a pull_request trigger");
  assert.match(trigger[1], /types: \[opened\]/u);
  assert.doesNotMatch(trigger[1], /branches(-ignore)?:/u);
});

test("C-REVIEW-01 pushes and ready transitions do not repeat automatic review", () => {
  assert.doesNotMatch(workflow, /synchronize|ready_for_review|reopened/u);
  assert.doesNotMatch(workflow, /pull_request_target:/u);
});

test("C-REVIEW-03 only a new exact standard command requests review", () => {
  assert.match(workflow, /issue_comment:\n {4}types: \[created\]/u);
  assert.match(workflow, /github\.event\.comment\.body == '\/review'/u);
  assert.doesNotMatch(workflow, /workflow_dispatch:|\/elwood review/u);
});

test("manual permission lookup failures select the authorization status reporter", async () => {
  const script = /script: \|\n([\s\S]*?)(?=\n {2}review:)/u.exec(workflow)?.[1];
  assert.ok(script, "the live authorization script must exist");
  const runGate = new (Object.getPrototypeOf(async () => undefined).constructor)(
    "github",
    "context",
    "core",
    script,
  );
  const reporter =
    / {2}report-authorization-status:[\s\S]*? {4}if: >-\n([\s\S]*?)(?= {4}runs-on:)/u.exec(
      workflow,
    )?.[1];
  assert.ok(reporter, "the authorization status reporter must exist");
  const selectsReporter = new Function("github", "needs", "always", `return ${reporter};`);
  const user = { type: "User", login: "writer" };
  const repo = { full_name: "with-logic/elwood" };
  const context = {
    repo: { owner: "with-logic", repo: "elwood" },
    eventName: "issue_comment",
    payload: { issue: { number: 173, pull_request: {} }, comment: { id: 1 } },
  };
  for (const status of [403, 404, 500]) {
    const error = Object.assign(new Error(`permission lookup ${status}`), { status });
    const outputs = {};
    const github = {
      rest: {
        pulls: { get: async () => ({ data: { user, head: { repo }, base: { repo } } }) },
        issues: {
          getComment: async () => ({
            data: { body: "/review", user: { ...user, login: "requester" } },
          }),
        },
        repos: {
          getCollaboratorPermissionLevel: ({ username }) => {
            if (username === "requester") return Promise.reject(error);
            return Promise.resolve({ data: { permission: "write" } });
          },
        },
      },
    };
    let result = "success";
    await runGate(github, context, {
      setOutput: (key, value) => {
        outputs[key] = value;
      },
    }).catch((caught) => {
      assert.equal(caught, error);
      result = "failure";
    });
    assert.equal(result, status === 404 ? "success" : "failure", `HTTP ${status}`);
    assert.equal(outputs.eligible, "false");
    assert.equal(
      selectsReporter(
        {
          event_name: context.eventName,
          event: { issue: context.payload.issue, comment: { body: "/review" } },
        },
        { authorize: { result } },
        () => true,
      ),
      status !== 404,
      `HTTP ${status} reporter selection`,
    );
  }
});
