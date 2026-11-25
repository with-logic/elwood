/** Exercises committed-history range selection and finding handling for PRD §16. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  commit,
  dockerWithFinding,
  git,
  rangeScript,
  scanScript,
  workflow,
} from "./secret-scan-fixture.mjs";

const scratch = mkdtempSync(join(tmpdir(), "elwood-secret-scan-"));
const seed = join(scratch, "seed");
const checkout = join(scratch, "checkout");
const zeroSha = "0".repeat(40);
let forkPoint;
let defaultTip;
let previousTip;
let mergeBaseSha;
let head;

before(() => {
  git(scratch, "init", "--initial-branch=main", seed);
  forkPoint = commit(seed, "Common ancestor");
  git(seed, "switch", "-c", "feature");
  previousTip = commit(seed, "Old feature tip");
  git(seed, "switch", "main");
  mergeBaseSha = commit(seed, "New base");
  git(seed, "switch", "-C", "feature");
  head = commit(seed, "Rebased feature tip");
  git(seed, "switch", "main");
  defaultTip = commit(seed, "Default branch advanced again");
  git(scratch, "clone", "--no-local", "--branch", "feature", seed, checkout);
});
after(() => rmSync(scratch, { recursive: true, force: true }));

function runScan(
  { base, event = "push", forced = "false", ref = "refs/heads/feature" },
  script = `${rangeScript}\nprintf "%s\\n" "$range" "$is_full_history_scan"`,
  extraEnv = {},
) {
  const result = spawnSync("bash", ["-c", script], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: ref,
      SCAN_BASE: base,
      SCAN_DEFAULT_BRANCH: "main",
      SCAN_HEAD: head,
      SCAN_PUSH_FORCED: forced,
      ...extraEnv,
    },
  });
  if (result.error) throw result.error;
  return result;
}

test("the workflow binds the GitHub push force flag to the range selector", () => {
  assert.match(
    workflow,
    /^ +SCAN_PUSH_FORCED: \$\{\{ github\.event_name == 'push' && github\.event\.forced == true \}\}$/mu,
  );
});

test("force-pushed branch scans from its actual merge base when the old tip is absent", () => {
  assert.throws(() => git(checkout, "cat-file", "-e", previousTip));
  const result = runScan({ base: previousTip, forced: "true" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${mergeBaseSha}..${head}\nfalse\n`);
  assert.ok(result.stderr.includes(`default-branch merge base ${mergeBaseSha}`));
});

test("a finding in the force-push fallback range fails the scan step", () => {
  const outputFile = join(scratch, "fallback-scan-output");
  const result = runScan(
    { base: previousTip, forced: "true" },
    `${dockerWithFinding}\n${scanScript}`,
    {
      EXPECTED_SCAN_RANGE: `${mergeBaseSha}..${head}`,
      GITHUB_OUTPUT: outputFile,
      GITHUB_WORKSPACE: checkout,
      GITLEAKS_IMAGE: "fixture",
    },
  );
  assert.equal(result.status, 20, result.stderr);
  assert.equal(readFileSync(outputFile, "utf8"), "finding-count=1\n");
});

for (const event of ["push", "pull_request", "pull_request_target", "merge_group"]) {
  test(`${event} uses the exact range when the base is available`, () => {
    const result = runScan({ base: forkPoint, event, forced: "true" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${forkPoint}..${head}\nfalse\n`);
  });
}

for (const [label, event] of [
  ["ordinary feature push", {}],
  ["forced default-branch push", { forced: "true", ref: "refs/heads/main" }],
  ["forced tag push", { forced: "true", ref: "refs/tags/v0.7.0" }],
  ["pull_request", { forced: "true", event: "pull_request" }],
  ["pull_request_target", { forced: "true", event: "pull_request_target" }],
  ["merge_group", { forced: "true", event: "merge_group" }],
]) {
  test(`${label} fails when the required base commit is unavailable`, () => {
    const result = runScan({ base: previousTip, ...event });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not resolve the base commit/u);
  });
}

test("a non-commit object is never treated as a missing previous tip", () => {
  const tree = git(checkout, "rev-parse", "HEAD^{tree}");
  const result = runScan({ base: tree, forced: "true" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not resolve the base commit/u);
});

test("a Git lookup error is never treated as a missing previous tip", () => {
  const directory = join(checkout, ".git", "objects", previousTip.slice(0, 2));
  const objectPath = join(directory, previousTip.slice(2));
  mkdirSync(directory, { recursive: true });
  writeFileSync(objectPath, "invalid fixture object");
  try {
    const result = runScan({ base: previousTip, forced: "true" });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "Secret scan could not resolve the base commit.\n");
  } finally {
    rmSync(objectPath);
  }
});

for (const [label, event] of [
  ["default-branch push", { event: "push", ref: "refs/heads/main" }],
  ["forced feature push", { event: "push", forced: "true" }],
  ["pull_request", { event: "pull_request" }],
  ["pull_request_target", { event: "pull_request_target" }],
  ["merge_group", { event: "merge_group" }],
]) {
  for (const [kind, base] of [
    ["an empty", ""],
    ["a malformed", "HEAD"],
  ]) {
    test(`${label} fails with ${kind} base`, () => {
      const result = runScan({ base, ...event });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
    });
  }
}

test("a first feature push scans the branch range", () => {
  const result = runScan({ base: zeroSha });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${mergeBaseSha}..${head}\nfalse\n`);
});

for (const [label, event] of [
  ["first default-branch push", { base: zeroSha, ref: "refs/heads/main" }],
  ["new tag push", { base: zeroSha, ref: "refs/tags/v0.7.0" }],
  ["manual audit", { base: "", event: "workflow_dispatch" }],
]) {
  test(`${label} scans the full history`, () => {
    const result = runScan(event);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${head}\ntrue\n`);
  });
}

test("a force-push fails if the fetched default branch cannot supply a merge base", () => {
  git(checkout, "update-ref", "-d", "refs/remotes/origin/main");
  try {
    const result = runScan({ base: previousTip, forced: "true" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not resolve the default-branch merge base/u);
  } finally {
    git(checkout, "update-ref", "refs/remotes/origin/main", defaultTip);
  }
});
