/** Exercises the committed-history range selected by the secret scan workflow. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/secret-scan.yml", import.meta.url),
  "utf8",
);
const rangeScript =
  / +id: scan\n[\s\S]*? +run: \|\n([\s\S]+?)\n +# End scan range selection\./u.exec(workflow)?.[1];
if (!rangeScript) throw new Error("The scan step must select its range before creating reports.");

const scratch = mkdtempSync(join(tmpdir(), "elwood-secret-scan-"));
const seed = join(scratch, "seed");
const checkout = join(scratch, "checkout");
const zeroSha = "0".repeat(40);
let forkPoint;
let defaultTip;
let previousTip;
let mergeBaseSha;
let head;

function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function commit(cwd, message) {
  git(cwd, "commit", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

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

function resolveRange({ base, event = "push", forced = "false", ref = "refs/heads/feature" }) {
  const result = spawnSync(
    "bash",
    ["-c", `${rangeScript}\nprintf "%s\\n" "$range" "$is_full_history_scan"`],
    {
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
      },
    },
  );
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
  const result = resolveRange({ base: previousTip, forced: "true" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${mergeBaseSha}..${head}\nfalse\n`);
  assert.ok(result.stderr.includes(`default-branch merge base ${mergeBaseSha}`));
});

test("an available base still defines the exact pushed or review range", () => {
  for (const event of ["push", "pull_request", "pull_request_target", "merge_group"]) {
    const result = resolveRange({ base: forkPoint, event, forced: "true" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${forkPoint}..${head}\nfalse\n`);
  }
});

test("missing base fails outside a confirmed force-push to a non-default branch", () => {
  const cases = [
    {},
    { forced: "true", ref: "refs/heads/main" },
    { forced: "true", ref: "refs/tags/v0.7.0" },
    { forced: "true", event: "pull_request" },
    { forced: "true", event: "pull_request_target" },
    { forced: "true", event: "merge_group" },
  ];
  for (const event of cases) {
    const result = resolveRange({ base: previousTip, ...event });
    assert.equal(result.status, 1, JSON.stringify(event));
    assert.match(result.stderr, /could not resolve the base commit/u);
  }
});

test("a non-commit object is never treated as a missing previous tip", () => {
  const tree = git(checkout, "rev-parse", "HEAD^{tree}");
  const result = resolveRange({ base: tree, forced: "true" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not resolve the base commit/u);
});

test("a Git lookup error is never treated as a missing previous tip", () => {
  const directory = join(checkout, ".git", "objects", previousTip.slice(0, 2));
  const objectPath = join(directory, previousTip.slice(2));
  mkdirSync(directory, { recursive: true });
  writeFileSync(objectPath, "invalid fixture object");
  try {
    const result = resolveRange({ base: previousTip, forced: "true" });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "Secret scan could not resolve the base commit.\n");
  } finally {
    rmSync(objectPath);
  }
});

test("malformed or absent event bases fail before selecting a scan range", () => {
  const events = [
    { event: "push", ref: "refs/heads/main" },
    { event: "push", forced: "true" },
    { event: "pull_request" },
    { event: "pull_request_target" },
    { event: "merge_group" },
  ];
  for (const event of events) {
    for (const base of ["", "HEAD"]) {
      const result = resolveRange({ base, ...event });
      assert.equal(result.status, 1, JSON.stringify({ base, event }));
      assert.equal(result.stdout, "");
    }
  }
});

test("first pushes and manual audits retain their scan ranges", () => {
  const branch = resolveRange({ base: zeroSha });
  assert.equal(branch.status, 0, branch.stderr);
  assert.equal(branch.stdout, `${mergeBaseSha}..${head}\nfalse\n`);

  for (const event of [
    { base: zeroSha, ref: "refs/heads/main" },
    { base: zeroSha, ref: "refs/tags/v0.7.0" },
    { base: "", event: "workflow_dispatch" },
  ]) {
    const full = resolveRange(event);
    assert.equal(full.status, 0, full.stderr);
    assert.equal(full.stdout, `${head}\ntrue\n`);
  }
});

test("a force-push fails if the fetched default branch cannot supply a merge base", () => {
  git(checkout, "update-ref", "-d", "refs/remotes/origin/main");
  try {
    const result = resolveRange({ base: previousTip, forced: "true" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not resolve the default-branch merge base/u);
  } finally {
    git(checkout, "update-ref", "refs/remotes/origin/main", defaultTip);
  }
});
