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

  assert.match(publish, /npm publish --access public/);
  assert.doesNotMatch(publish, /action-gh-release/);
  assert.match(githubRelease, /needs: \[resolve, publish\]/);
  assert.match(githubRelease, /uses: softprops\/action-gh-release/);
  assert.match(githubRelease, /tag_name:.*needs\.resolve\.outputs\.tag/);
  assert.doesNotMatch(githubRelease, /npm publish/);
});

// Answers only the exact lookup the step makes; any other call fails.
const releaseLookup = [
  "gh() {",
  '  [ "$GH_TOKEN" = fixture-token ] || return 2',
  '  [ "$*" = "release view v1.2.3 --repo $GITHUB_REPOSITORY --json isDraft --jq .isDraft" ] || return 2',
  '  [ -n "$FIXTURE_IS_DRAFT" ] || { echo "release not found" >&2; return 1; }',
  '  echo "$FIXTURE_IS_DRAFT"',
  "}",
].join("\n");

function checkRelease(name, isDraft) {
  // GitHub creates the output file before the step runs.
  const output = join(scratch, name);
  writeFileSync(output, "");
  const result = runStep("name: Check for a published GitHub release", {
    cwd: scratch,
    env: { FIXTURE_IS_DRAFT: isDraft, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "fixture/elwood" },
    expressions: { "github.token": "fixture-token", "needs.resolve.outputs.tag": "v1.2.3" },
    prelude: releaseLookup,
  });
  return { output: readFileSync(output, "utf8"), result };
}

test("a re-run leaves an already published GitHub release unchanged", () => {
  const { output, result } = checkRelease("published", "false");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output, "published=true\n");
  assert.match(
    job("github-release"),
    /- name: Create GitHub release\n {8}if: steps\.existing\.outputs\.published != 'true'\n/u,
  );
});

for (const [label, isDraft] of [
  ["a draft left by an interrupted attempt", "true"],
  ["a missing release", ""],
]) {
  test(`${label} goes to the release action`, () => {
    const { output, result } = checkRelease(label.replaceAll(" ", "-"), isDraft);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(output, "");
  });
}
