/** Keep GitHub release creation retryable after npm publication succeeds. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

test("GitHub release creation retries independently of npm publication", () => {
  const jobs = workflow.split(/^ {2}(?=[\w-]+:\s*$)/m);
  const publish = jobs.find((job) => job.startsWith("publish:\n"));
  const githubRelease = jobs.find((job) => job.startsWith("github-release:\n"));

  assert.ok(publish, "expected an npm publication job");
  assert.ok(githubRelease, "expected an independently retryable GitHub release job");
  assert.match(publish, /run: npm publish --access public/);
  assert.doesNotMatch(publish, /action-gh-release/);
  assert.match(githubRelease, /needs: \[resolve, publish\]/);
  assert.match(githubRelease, /uses: softprops\/action-gh-release/);
  assert.match(githubRelease, /tag_name:.*needs\.resolve\.outputs\.tag/);
  assert.doesNotMatch(githubRelease, /npm publish/);
});
