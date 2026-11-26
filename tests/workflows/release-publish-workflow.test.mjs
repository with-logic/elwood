/** Re-runs the release npm publication step with the real npm client, offline. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startRegistry } from "./npm-registry.mjs";
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

// Records each `npm publish` and runs it for real against the local registry
// as a dry run, so npm's own version and dist-tag checks still apply.
const dryRunPublish =
  'npm() { if [ "$1" = publish ]; then echo "$*" >> "$PUBLISH_LOG"; command npm "$@" --dry-run; else command npm "$@"; fi; }';

function publish({ name = "@with-logic/elwood", version, releaseCommit = otherCommit }) {
  const cwd = mkdtempSync(join(scratch, "package-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name, version }));
  const log = join(cwd, "publish.log");
  const output = join(cwd, "github-output");
  writeFileSync(log, "");
  writeFileSync(output, "");
  const result = runStep("name: Publish to npm", {
    cwd,
    env: { ...registry.env, GITHUB_OUTPUT: output, PUBLISH_LOG: log },
    expressions: {
      "needs.resolve.outputs.version": version,
      "needs.secret-scan.outputs.commit": releaseCommit,
    },
    prelude: dryRunPublish,
  });
  return { output: readFileSync(output, "utf8"), publishes: readFileSync(log, "utf8"), result };
}

for (const [version, distTag] of [
  ["0.8.0", "latest"],
  ["0.7.0", "latest-0.7"],
]) {
  test(`a re-run skips ${version}, which this workflow published from the release commit`, () => {
    const { output, publishes, result } = publish({ version, releaseCommit: commitOf[version] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(publishes, "");
    assert.equal(output, `dist_tag=${distTag}\n`);
    assert.match(result.stdout, /: skip .*this workflow already published it/u);
  });
}

test("a version newer than every published one publishes as latest", () => {
  const { output, publishes, result } = publish({ version: "0.9.0" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(publishes, "publish --access public\n");
  assert.equal(output, "dist_tag=latest\n");
});

test("a version a newer release overtook publishes under its line's dist-tag", () => {
  const { output, publishes, result } = publish({ version: "0.6.2" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(publishes, "publish --access public --tag latest-0.6\n");
  assert.equal(output, "dist_tag=latest-0.6\n");
  assert.match(result.stdout, /newer versions: 0\.7\.0 0\.8\.0/u);
});

for (const [label, options, reason] of [
  [
    "a version a maintainer published by hand",
    { version: "0.1.0", releaseCommit: commitOf["0.1.0"] },
    `already published from ${commitOf["0.1.0"]} by maintainer@example.test`,
  ],
  [
    "a version published from another commit",
    { version: "0.8.0" },
    `already published from ${commitOf["0.8.0"]} by npm-oidc-no-reply@github.com`,
  ],
  [
    "a failed registry lookup",
    { name: "@with-logic/registry-down", version: "1.0.0" },
    "could not read the registry: E500",
  ],
]) {
  test(`${label} fails the step without publishing`, () => {
    const { output, publishes, result } = publish(options);
    assert.equal(result.status, 1);
    assert.equal(publishes, "");
    assert.equal(output, "");
    assert.ok(
      result.stdout.includes(
        `::error::cannot publish ${options.name ?? "@with-logic/elwood"}@${options.version}: ${reason}\n`,
      ),
      result.stdout,
    );
  });
}
