/** Exercises GitHub author permissions and the narrowly scoped Dependabot exception. */
import assert from "node:assert/strict";
import test from "node:test";
import { authorPermission, currentPr } from "../github.mjs";
import { eligible } from "../policy.mjs";

function fixture(user = { login: "maintainer", type: "User" }) {
  const calls = [];
  const reads = [];
  const pr = {
    number: 10,
    user,
    state: "open",
    draft: false,
    head: { repo: { full_name: "with-logic/elwood" } },
    base: { ref: "main" },
  };
  const state = { permission: "write", error: null };
  const github = {
    rest: {
      pulls: {
        get(args) {
          reads.push(args);
          return { data: pr };
        },
      },
      repos: {
        getCollaboratorPermissionLevel(args) {
          calls.push(args);
          if (state.error) throw state.error;
          return { data: { permission: state.permission } };
        },
      },
    },
  };
  const context = { repo: { owner: "with-logic", repo: "elwood" } };
  return { pr, state, calls, reads, read: () => currentPr(github, context, 10) };
}

test("same-repository Dependabot Bot qualifies without a collaborator lookup", async () => {
  const f = fixture({ login: "dependabot[bot]", type: "Bot" });
  f.state.error = new Error("The exception must not call the collaborator API");
  const result = await f.read();
  assert.deepEqual(f.reads, [{ owner: "with-logic", repo: "elwood", pull_number: 10 }]);
  assert.equal(result.permission, "write");
  assert.equal(eligible(result.pr, "with-logic/elwood", result.permission), true);
  assert.deepEqual(f.calls, []);
  f.pr.head.repo.full_name = "stranger/elwood";
  const fork = await f.read();
  assert.equal(eligible(fork.pr, "with-logic/elwood", fork.permission), false);
});

test("a regular user cannot impersonate Dependabot to bypass collaborator permissions", async () => {
  for (const user of [
    { login: "dependabot[bot]", type: "User" },
    { login: "stranger[bot]", type: "Bot" },
  ]) {
    const f = fixture(user);
    f.state.permission = "read";
    const result = await f.read();
    assert.equal(result.permission, "read");
    assert.equal(eligible(result.pr, "with-logic/elwood", result.permission), false);
    assert.deepEqual(f.calls, [{ owner: "with-logic", repo: "elwood", username: user.login }]);
  }
});

test("a missing collaborator permission is none and cannot qualify", async () => {
  const f = fixture();
  f.state.error = Object.assign(new Error("Not Found"), { status: 404 });
  const result = await f.read();
  assert.equal(result.permission, "none");
  assert.equal(eligible(result.pr, "with-logic/elwood", result.permission), false);
});

test("permission API failures propagate rather than granting eligibility", async () => {
  for (const status of [403, 500, undefined]) {
    const f = fixture();
    const error = Object.assign(new Error("Permission lookup failed"), { status });
    f.state.error = error;
    await assert.rejects(f.read(), (caught) => caught === error);
    assert.equal(f.calls.length, 1);
  }
});

test("nullish and primitive permission failures preserve the original rejection", async () => {
  for (const rejection of [null, undefined, "network unavailable", 0]) {
    const github = {
      rest: { repos: { getCollaboratorPermissionLevel: () => Promise.reject(rejection) } },
    };
    let caught = Symbol("not caught");
    try {
      await authorPermission(
        github,
        { repo: { owner: "with-logic", repo: "elwood" } },
        { login: "writer" },
      );
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, rejection);
  }
});
