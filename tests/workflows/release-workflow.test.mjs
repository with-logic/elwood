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
  '    *) echo \'{"message":"Bad credentials","status":"401"}\'',
  '      echo "gh: Bad credentials (HTTP 401)" >&2; return 1 ;;',
  "  esac",
  "}",
].join("\n");

function checkRelease(status) {
  // GitHub creates the output file before the step runs.
  const output = join(scratch, `release-lookup-${status}`);
  writeFileSync(output, "");
  const result = runStep("name: Check for a published GitHub release", {
    cwd: scratch,
    env: { FIXTURE_STATUS: status, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "fixture/elwood" },
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

test("a failed GitHub release lookup fails the job", () => {
  const { output, result } = checkRelease("401");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::could not look up GitHub release v1\.2\.3: .*HTTP 401/su);
  assert.equal(output, "");
});
