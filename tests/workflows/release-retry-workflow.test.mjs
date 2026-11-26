/** Re-runs the release tag, resolve and npm steps after a partial release. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { commit, git } from "./git-fixture.mjs";
import { runStep } from "./release-fixture.mjs";

const scratch = mkdtempSync(join(tmpdir(), "elwood-release-retry-"));
const origin = join(scratch, "origin.git");
const seed = join(scratch, "seed");
const npmrc = join(scratch, "npmrc");
let earlier;
let release;

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
  // What actions/setup-node writes for `registry-url: https://registry.npmjs.org`.
  writeFileSync(
    npmrc,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: npm expands this npmrc placeholder.
    "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\nregistry=https://registry.npmjs.org/\n",
  );
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

test("a checked-out tag on another commit fails the step", () => {
  const result = createTag(checkout("elsewhere", { "v1.0.2": earlier }), "v1.0.2");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /tag v1\.0\.2 already exists on another commit/u);
  assert.equal(remoteTag("v1.0.2"), earlier);
});

test("a tag pushed on another commit after checkout rejects the push", () => {
  const cwd = checkout("late");
  git(seed, "push", origin, `${earlier}:refs/tags/v1.0.3`);
  const result = createTag(cwd, "v1.0.3");
  assert.notEqual(result.status, 0);
  assert.equal(remoteTag("v1.0.3"), earlier);
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
  ["a version bump", undefined],
  ["re-running all jobs after the tag was pushed", () => release],
]) {
  test(`${label} resolves a release`, () => {
    const { result, output } = resolve(tagTarget?.());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(output, "should_release=true\nversion=1.2.3\ntag=v1.2.3\n");
  });
}

test("a version bump whose tag names another commit is not released", () => {
  const { result } = resolve(earlier);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /tag v1\.2\.3 already exists on another commit/u);
});

// The real registry answers the lookup; only `npm publish` itself is stubbed.
const recordPublish =
  'npm() { if [ "$1" = publish ]; then echo "$*" >> "$PUBLISH_LOG"; else command npm "$@"; fi; }';
const publishedFromWorkflow = {
  version: "0.7.0",
  commit: "5ac725b514fe26d1ef71a837f029c8f6fd15c4d3",
};

function publish(name, version, releaseCommit) {
  const cwd = join(scratch, name);
  mkdirSync(cwd);
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "@with-logic/elwood", version }));
  const log = join(cwd, "publish.log");
  writeFileSync(log, "");
  const result = runStep("name: Publish to npm", {
    cwd,
    env: {
      NODE_AUTH_TOKEN: "XXXXX-XXXXX-XXXXX-XXXXX",
      PUBLISH_LOG: log,
      npm_config_cache: join(scratch, "npm-cache"),
      npm_config_update_notifier: "false",
      npm_config_userconfig: npmrc,
    },
    expressions: {
      "needs.resolve.outputs.version": version,
      "needs.secret-scan.outputs.commit": releaseCommit,
    },
    prelude: recordPublish,
  });
  return { publishes: readFileSync(log, "utf8"), result };
}

test("a re-run skips a version npm already published from the release commit", () => {
  const { version, commit: published } = publishedFromWorkflow;
  const { publishes, result } = publish("published", version, published);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(publishes, "");
  assert.match(result.stdout, /@with-logic\/elwood@0\.7\.0 is already published from/u);
});

for (const [label, version, releaseCommit] of [
  ["an unpublished version", "0.0.0-never-published", publishedFromWorkflow.commit],
  ["a version published from another commit", publishedFromWorkflow.version, "0".repeat(40)],
]) {
  test(`${label} goes to npm publish`, () => {
    const { publishes, result } = publish(label.replaceAll(" ", "-"), version, releaseCommit);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(publishes, "publish --access public\n");
  });
}
