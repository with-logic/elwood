/** Exercises GitHub author permissions and the narrowly scoped Dependabot exception. */
import assert from "node:assert/strict";
import test from "node:test";
import { effectiveUserPermission } from "../github.mjs";

function fixture(user = { login: "maintainer", type: "User" }) {
  const calls = [];
  const state = { permission: "write", error: null };
  const github = {
    rest: {
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
  return { state, calls, read: () => effectiveUserPermission(github, context, user) };
}

test("Dependabot Bot receives write permission without a collaborator lookup", async () => {
  const f = fixture({ login: "dependabot[bot]", type: "Bot" });
  f.state.error = new Error("The exception must not call the collaborator API");
  const result = await f.read();
  assert.equal(result, "write");
  assert.deepEqual(f.calls, []);
});

test("a regular user cannot impersonate Dependabot to bypass collaborator permissions", async () => {
  for (const user of [
    { login: "dependabot[bot]", type: "User" },
    { login: "stranger[bot]", type: "Bot" },
  ]) {
    const f = fixture(user);
    f.state.permission = "read";
    const result = await f.read();
    assert.equal(result, "read");
    assert.deepEqual(f.calls, [{ owner: "with-logic", repo: "elwood", username: user.login }]);
  }
});

test("a missing collaborator permission is none and cannot qualify", async () => {
  const f = fixture();
  f.state.error = Object.assign(new Error("Not Found"), { status: 404 });
  const result = await f.read();
  assert.equal(result, "none");
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
      await effectiveUserPermission(
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
