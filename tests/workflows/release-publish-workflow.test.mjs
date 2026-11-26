/** Re-runs the release npm publication step with the real npm client, offline. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startRegistry } from "./npm-registry-fixture.mjs";
import { runStep } from "./release-fixture.mjs";

const scratch = mkdtempSync(join(tmpdir(), "elwood-release-publish-"));
let registry;
before(async () => {
  registry = await startRegistry(scratch);
});
after(() => {
  registry?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

// The recorded releases: this workflow published 0.7.0 and 0.8.0 (`latest`)
// through trusted publishing, and a maintainer published 0.1.0 by hand.
const commitOf = {
  "0.1.0": "d8b4e78e0d6979f6a081689fcbb42987a2c66d7f",
  "0.7.0": "5ac725b514fe26d1ef71a837f029c8f6fd15c4d3",
  "0.8.0": "86b962487b962a1c8ff628aee7ad45fc527a386e",
};
const otherCommit = "0".repeat(40);
const handPublisher = "maintainer@example.test";

// Records each `npm publish` and runs it for real against the local registry
// as a dry run, so npm's own version and dist-tag checks still apply.
const dryRunPublish =
  'npm() { if [ "$1" = publish ]; then echo "$*" >> "$PUBLISH_LOG"; command npm "$@" --dry-run; else command npm "$@"; fi; }';

function publish({
  name = "@with-logic/elwood",
  version,
  releaseCommit = otherCommit,
  prelude = "",
}) {
  const cwd = mkdtempSync(join(scratch, "package-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name, version }));
  const log = join(cwd, "publish.log");
  writeFileSync(log, "");
  const result = runStep("name: Publish to npm", {
    cwd,
    env: { ...registry.env, PUBLISH_LOG: log },
    expressions: {
      "needs.resolve.outputs.version": version,
      "needs.secret-scan.outputs.commit": releaseCommit,
    },
    prelude: `${dryRunPublish}\n${prelude}`,
  });
  return { publishes: readFileSync(log, "utf8"), result };
}

for (const version of ["0.8.0", "0.7.0"]) {
  test(`a re-run skips ${version}, which this workflow published from the release commit`, () => {
    const { publishes, result } = publish({ version, releaseCommit: commitOf[version] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(publishes, "");
    assert.match(result.stdout, /This workflow already published .*; skipping\./u);
  });
}

test("a version not on npm publishes", () => {
  const { publishes, result } = publish({ version: "0.9.0" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(publishes, "publish --access public\n");
  assert.match(result.stdout, /: unpublished\n/u);
});

// Out of scope for re-runs: npm refuses to move `latest` back.
test("a version older than the newest one on npm stops at npm's refusal", () => {
  const { publishes, result } = publish({ version: "0.6.2" });
  assert.equal(result.status, 1);
  assert.equal(publishes, "publish --access public\n");
  assert.match(
    result.stderr,
    /Cannot implicitly apply the "latest" tag because .* 0\.8\.0 is higher/u,
  );
});

for (const [label, options, reason] of [
  [
    "a version a maintainer published by hand",
    { version: "0.1.0", releaseCommit: commitOf["0.1.0"] },
    `is already on npm, from ${commitOf["0.1.0"]} by another account; npm never replaces a version`,
  ],
  [
    "a version published from another commit",
    { version: "0.8.0" },
    `is already on npm, from ${commitOf["0.8.0"]} by trusted publishing; npm never replaces a version`,
  ],
  [
    "a failed registry lookup",
    { name: "@with-logic/registry-down", version: "1.0.0" },
    "could not read @with-logic/registry-down@1.0.0 from the registry: lookup-failed E500",
  ],
  [
    "a lookup that yields no answer",
    // The decision step printing nothing, as when its output is lost.
    {
      version: "0.1.0",
      prelude: 'node() { if [ "$1" = -e ]; then return 0; fi; command node "$@"; }',
    },
    "could not read @with-logic/elwood@0.1.0 from the registry: no answer",
  ],
]) {
  test(`${label} fails the step without publishing`, () => {
    const { publishes, result } = publish(options);
    assert.equal(result.status, 1);
    assert.equal(publishes, "");
    assert.ok(result.stdout.includes(`::error::`), result.stdout);
    assert.ok(result.stdout.includes(`${reason}\n`), result.stdout);
    // The registry's publisher email stays out of the log.
    assert.ok(!`${result.stdout}${result.stderr}`.includes(handPublisher), result.stdout);
  });
}
