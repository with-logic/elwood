/** Shared fake GitHub boundary and real temporary review reports. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportFixture } from "./report-fixture.mjs";

export function fixture() {
  const outputs = {};
  const posted = [];
  const failures = [];
  const pr = {
    number: 10,
    state: "open",
    draft: false,
    user: { login: "maintainer", type: "User" },
    head: { sha: "head", repo: { full_name: "with-logic/elwood" } },
    base: { ref: "main", sha: "base", repo: { full_name: "with-logic/elwood" } },
  };
  const state = { permission: "write", reviews: [] };
  const github = {
    graphql() {
      return { repository: { pullRequest: { reviewDecision: "REVIEW_REQUIRED" } } };
    },
    rest: {
      pulls: {
        get() {
          return { data: pr };
        },
        listReviews: "listReviews",
        createReview(review) {
          posted.push(review);
          return { data: { id: 123 } };
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

export async function report(t, content = reportFixture()) {
  const dir = await mkdtemp(join(tmpdir(), "elwood-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "REVIEW.md");
  await writeFile(path, content);
  return path;
}
