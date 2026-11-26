/** Keep GitHub release creation retryable after npm publication succeeds. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { job, runStep } from "./release-fixture.mjs";

const scratch = mkdtempSync(join(tmpdir(), "elwood-release-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("GitHub release creation retries independently of npm publication", () => {
  const publish = job("publish");
  const githubRelease = job("github-release");

  assert.match(publish, /^ +npm publish --access public$/mu);
  assert.doesNotMatch(publish, /action-gh-release/);
  assert.match(githubRelease, /needs: \[resolve, publish\]/);
  assert.match(githubRelease, /uses: softprops\/action-gh-release/);
  assert.match(githubRelease, /tag_name:.*needs\.resolve\.outputs\.tag/);
  assert.doesNotMatch(githubRelease, /npm publish/);
});

// GitHub orders `legacy` releases by commit date, so re-running an older
// release's job leaves the newest release Latest.
test("the GitHub release leaves Latest to GitHub's commit-date order", () => {
  assert.match(
    job("github-release"),
    /uses: softprops\/action-gh-release@v2\n {8}with:\n(?: {10}\S.*\n)*? {10}make_latest: legacy\n/u,
  );
});

const workflow = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

// The re-run notes sit directly above `on:`; an edit to them must keep every release path.
test("the release workflow keeps its push, tag and manual triggers", () => {
  assert.match(
    workflow,
    /^on:\n {2}push:\n {4}branches: \[main\]\n {4}tags: \["v\*\.\*\.\*"\]\n {2}workflow_dispatch:\n/mu,
  );
});

// npm moves `latest` to whatever version an upload names, after checks that
// read the registry first, so overlapping runs could leave it on the older
// version; GitHub's default queue would cancel a waiting release.
test("release runs take turns, keeping every waiting run", () => {
  assert.match(
    workflow,
    /^concurrency:\n {2}group: release-\$\{\{ github\.repository \}\}\n {2}cancel-in-progress: false\n {2}queue: max\n\njobs:\n/mu,
  );
});

// Replays real `gh api` answers for the exact lookup the step makes; any
// other call fails. GitHub answers 404 for a draft as for a missing release.
const releaseLookup = [
  "gh() {",
  '  [ "$GH_TOKEN" = fixture-token ] || return 2',
  '  [ "$*" = "api repos/$GITHUB_REPOSITORY/releases/tags/v1.2.3 --jq .html_url" ] || return 2',
  '  case "$FIXTURE_STATUS" in',
  '    200) echo "https://github.com/$GITHUB_REPOSITORY/releases/tag/v1.2.3" ;;',
  '    404) echo \'{"message":"Not Found","status":"404"}\'',
  '      echo "gh: Not Found (HTTP 404)" >&2; return 1 ;;',
  '    401) echo \'{"message":"Bad credentials","status":"401"}\'',
  '      echo "gh: Bad credentials (HTTP 401)" >&2; return 1 ;;',
  '    *) echo "error connecting to api.github.com" >&2; return 1 ;;',
  "  esac",
  "}",
].join("\n");

function checkRelease(status) {
  // GitHub creates the output file before the step runs.
  const output = join(scratch, `release-lookup-${status}`);
  writeFileSync(output, "");
  const result = runStep("name: Check for a published GitHub release", {
    cwd: scratch,
    env: {
      FIXTURE_STATUS: status,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "fixture/elwood",
      RUNNER_TEMP: scratch,
    },
    expressions: { "github.token": "fixture-token", "needs.resolve.outputs.tag": "v1.2.3" },
    prelude: releaseLookup,
  });
  return { output: readFileSync(output, "utf8"), result };
}

test("a re-run leaves an already published GitHub release unchanged", () => {
  const { output, result } = checkRelease("200");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output, "published=true\n");
  assert.match(
    job("github-release"),
    /- name: Check for a published GitHub release\n {8}id: existing\n[\s\S]*?- name: Create GitHub release\n {8}if: steps\.existing\.outputs\.published != 'true'\n/u,
  );
});

test("a draft or missing GitHub release goes to the release action", () => {
  const { output, result } = checkRelease("404");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output, "");
});

for (const [label, status, reason] of [
  ["a failed GitHub release lookup", "401", "HTTP 401"],
  ["a GitHub release lookup that never reaches GitHub", "offline", "no HTTP status"],
]) {
  test(`${label} fails the job, logging only its status`, () => {
    const { output, result } = checkRelease(status);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, `::error::could not look up GitHub release v1.2.3: ${reason}\n`);
    assert.equal(output, "");
  });
}
