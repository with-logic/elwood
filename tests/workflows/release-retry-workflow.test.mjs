/** Re-runs the release resolve and tag steps after a partial release. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { commit, git } from "./git-fixture.mjs";
import { runStep } from "./release-fixture.mjs";

const scratch = mkdtempSync(join(tmpdir(), "elwood-release-retry-"));
const origin = join(scratch, "origin.git");
const seed = join(scratch, "seed");
let earlier;
let release;
let annotated;

before(() => {
  git(scratch, "init", "--bare", "--initial-branch=main", origin);
  git(scratch, "init", "--initial-branch=main", seed);
  writeFileSync(join(seed, "package.json"), '{ "version": "1.2.2" }\n');
  git(seed, "add", "package.json");
  earlier = commit(seed, "Earlier release");
  writeFileSync(join(seed, "package.json"), '{ "version": "1.2.3" }\n');
  git(seed, "add", "package.json");
  release = commit(seed, "Release 1.2.3");
  git(seed, "push", origin, "main");
  // The workflow only creates lightweight tags; a hand-made annotated tag is not one of its own.
  git(seed, "tag", "-a", "-m", "Annotated by hand", "annotated", release);
  annotated = git(seed, "rev-parse", "refs/tags/annotated");
});
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Clones origin with all of its tags, as the publish job's checkout does. */
function checkout(name, tags = {}) {
  for (const [tag, target] of Object.entries(tags)) {
    git(seed, "push", origin, `${target}:refs/tags/${tag}`);
  }
  const directory = join(scratch, name);
  git(scratch, "clone", "--quiet", origin, directory);
  return directory;
}

function remoteTag(tag) {
  return git(seed, "ls-remote", origin, `refs/tags/${tag}`).split("\t")[0];
}

function createTag(cwd, tag) {
  return runStep("name: Create tag", {
    cwd,
    expressions: { "needs.resolve.outputs.tag": tag, "needs.secret-scan.outputs.commit": release },
  });
}

test("a first release attempt tags the release commit", () => {
  const result = createTag(checkout("first"), "v1.0.0");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(remoteTag("v1.0.0"), release);
});

test("a re-run after a failed publish reuses the tag its first attempt pushed", () => {
  const result = createTag(checkout("rerun", { "v1.0.1": release }), "v1.0.1");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(remoteTag("v1.0.1"), release);
});

// Tag targets are read inside each test because before() assigns them.
for (const [label, tag, target] of [
  ["a tag on another commit", "v1.0.2", () => earlier],
  ["an annotated tag on the release commit", "v1.0.3", () => annotated],
]) {
  test(`${label} rejects the tag push`, () => {
    const result = createTag(checkout(tag, { [tag]: target() }), tag);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\[rejected\]/u);
    assert.equal(remoteTag(tag), target());
  });
}

test("a tag pushed on another commit after checkout rejects the push", () => {
  const cwd = checkout("late");
  git(seed, "push", origin, `${earlier}:refs/tags/v1.0.4`);
  const result = createTag(cwd, "v1.0.4");
  assert.notEqual(result.status, 0);
  assert.equal(remoteTag("v1.0.4"), earlier);
});

function resolve(tagTarget) {
  const output = join(scratch, `resolve-output-${tagTarget ?? "untagged"}`);
  if (tagTarget) git(seed, "tag", "v1.2.3", tagTarget);
  try {
    const result = runStep("id: decide", {
      cwd: seed,
      env: { GITHUB_OUTPUT: output, GITHUB_REF: "refs/heads/main" },
      expressions: {
        "github.event.before": earlier,
        "github.event_name": "push",
        "inputs.version": "",
      },
    });
    return { result, output: result.status === 0 ? readFileSync(output, "utf8") : "" };
  } finally {
    if (tagTarget) git(seed, "tag", "-d", "v1.2.3");
  }
}

for (const [label, tagTarget] of [
  ["a version bump", () => undefined],
  ["re-running all jobs after the tag was pushed", () => release],
]) {
  test(`${label} resolves a release`, () => {
    const { result, output } = resolve(tagTarget());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(output, "should_release=true\nversion=1.2.3\ntag=v1.2.3\n");
  });
}

for (const [label, tagTarget] of [
  ["names another commit", () => earlier],
  ["is annotated", () => annotated],
]) {
  test(`a version bump whose tag ${label} is not released`, () => {
    const { result } = resolve(tagTarget());
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /tag v1\.2\.3 already exists and is not a lightweight tag on this commit/u,
    );
  });
}
