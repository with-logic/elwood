/** Verifies only trusted authors enter credentialed review discussion context. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discussion, trustedDiscussion } from "../discussion.mjs";

const context = { repo: { owner: "with-logic", repo: "elwood" } };
const record = (login, association = "COLLABORATOR", type = "User") => ({
  user: { login, type },
  author_association: association,
  body: `${login} says hello`,
});
function fixture(permission = "write") {
  const calls = [];
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel(args) {
          calls.push(args.username);
          return { data: { permission } };
        },
      },
    },
  };
  return { github, calls };
}

test("public authors and missing users are excluded without permission lookups", async () => {
  const { github, calls } = fixture();
  const result = await trustedDiscussion(github, context, [
    record("public", "NONE"),
    record("past", "CONTRIBUTOR"),
    {},
  ]);
  assert.deepEqual(result, []);
  assert.deepEqual(calls, []);
});

test("association does not grant access and current permissions are cached per author", async () => {
  for (const permission of ["read", "triage", "none", "write", "maintain", "admin"]) {
    const { github, calls } = fixture(permission);
    const result = await trustedDiscussion(github, context, [
      record("member", "MEMBER"),
      record("member", "OWNER"),
    ]);
    assert.equal(result.length, ["write", "maintain", "admin"].includes(permission) ? 2 : 0);
    assert.deepEqual(calls, ["member"]);
  }
});

test("only exact known automation identities bypass permission lookups", async () => {
  const { github, calls } = fixture("read");
  const result = await trustedDiscussion(github, context, [
    record("github-actions[bot]", "NONE", "Bot"),
    record("dependabot[bot]", "NONE", "Bot"),
    record("github-actions[bot]"),
    record("unknown[bot]", "COLLABORATOR", "Bot"),
  ]);
  assert.deepEqual(
    result.map((entry) => entry.author),
    ["github-actions[bot]", "dependabot[bot]"],
  );
  assert.deepEqual(calls, ["github-actions[bot]", "unknown[bot]"]);
});

test("permission API errors never admit an unchecked author", async () => {
  const { github } = fixture();
  github.rest.repos.getCollaboratorPermissionLevel = () => {
    throw new Error("offline");
  };
  await assert.rejects(trustedDiscussion(github, context, [record("member")]), /offline/);
});

test("discussion writes the PR and filtered paginated comments and reviews", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elwood-discussion-"));
  try {
    const path = join(directory, "discussion.json");
    const { github } = fixture();
    const comments = Symbol("comments");
    const reviews = Symbol("reviews");
    github.rest.pulls = {
      get: () => ({ data: { title: "A fix", body: "Details" } }),
      listReviews: reviews,
    };
    github.rest.issues = { listComments: comments };
    github.paginate = (method, args) => {
      assert.equal(args.per_page, 100);
      if (method === comments) {
        assert.equal(args.issue_number, 12);
        return [record("public", "NONE"), record("maintainer")];
      }
      assert.equal(method, reviews);
      assert.equal(args.pull_number, 12);
      return [{ ...record("github-actions[bot]", "NONE", "Bot"), state: "COMMENTED" }];
    };
    await discussion({ github, context, number: "12", path });
    const result = JSON.parse(await readFile(path, "utf8"));
    assert.equal(result.title, "A fix");
    assert.equal(result.body, "Details");
    assert.deepEqual(
      result.discussion.map((entry) => entry.author),
      ["maintainer", "github-actions[bot]"],
    );
    assert.equal(result.discussion[1].state, "COMMENTED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
