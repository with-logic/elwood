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

// The recorded releases: this workflow's trusted publisher published 0.7.0 and
// 0.8.0 (`latest`), and a maintainer published 0.1.0 by hand.
const commitOf = {
  "0.1.0": "d8b4e78e0d6979f6a081689fcbb42987a2c66d7f",
  "0.7.0": "5ac725b514fe26d1ef71a837f029c8f6fd15c4d3",
  "0.8.0": "86b962487b962a1c8ff628aee7ad45fc527a386e",
};
const otherCommit = "0".repeat(40);
const handPublisher = "maintainer@example.test";
// Nothing listens here: no listen(0) picks a port below the ephemeral range,
// and fetch, unlike for port 1, does not refuse to try it.
const unreachable = "http://127.0.0.1:1023/";
// npm's retry settings, with a 1 ms wait.
const retrying = (retries) => ({
  npm_config_fetch_retries: String(retries),
  npm_config_fetch_retry_mintimeout: "1",
});

// Records each `npm publish` and runs it for real against the local registry
// as a dry run, so npm's own version and dist-tag checks still apply.
const dryRunPublish =
  'npm() { if [ "$1" = publish ]; then echo "$*" >> "$PUBLISH_LOG"; command npm "$@" --dry-run; else command npm "$@"; fi; }';

function publish({
  name = "@with-logic/elwood",
  version,
  releaseCommit = otherCommit,
  prelude = "",
  env = {},
}) {
  const cwd = mkdtempSync(join(scratch, "package-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name, version }));
  const log = join(cwd, "publish.log");
  writeFileSync(log, "");
  const result = runStep("name: Publish to npm", {
    cwd,
    env: { ...registry.env, ...env, PUBLISH_LOG: log },
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

for (const [failure, name] of [
  ["answers 503", "@with-logic/elwood-flaky"],
  ["drops the connection", "@with-logic/elwood-dropped"],
]) {
  test(`a lookup retries a registry that ${failure} once`, () => {
    const { publishes, result } = publish({
      name,
      version: "0.8.0",
      releaseCommit: commitOf["0.8.0"],
      env: retrying(1),
    });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(publishes, "");
    assert.match(result.stdout, /: published-here\n/u);
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
    `is already on npm, from ${commitOf["0.8.0"]} by this workflow; npm never replaces a version`,
  ],
  [
    "a version another trusted publisher published from the release commit",
    { name: "@with-logic/elwood-reconfigured", version: "0.8.0", releaseCommit: commitOf["0.8.0"] },
    `is already on npm, from ${commitOf["0.8.0"]} by a trusted publisher with configuration ID "00000000-0000-4000-8000-000000000000", not NPM_TRUSTED_PUBLISHER_CONFIG_ID; npm never replaces a version`,
  ],
  [
    "a version whose trusted publisher the registry records without a configuration ID",
    { name: "@with-logic/elwood-unrecorded", version: "0.7.0", releaseCommit: commitOf["0.7.0"] },
    `is already on npm, from ${commitOf["0.7.0"]} by a trusted publisher with configuration ID null, not NPM_TRUSTED_PUBLISHER_CONFIG_ID; npm never replaces a version`,
  ],
  [
    "a version the registry records without a commit or publisher",
    { name: "@with-logic/elwood-unrecorded", version: "0.8.0", releaseCommit: commitOf["0.8.0"] },
    "is already on npm, from an unrecorded commit by an unrecorded publisher; npm never replaces a version",
  ],
  [
    "a registry lookup that still fails after its retries",
    { name: "@with-logic/registry-down", version: "1.0.0", env: retrying(2) },
    "could not read @with-logic/registry-down@1.0.0 from the registry: lookup-failed HTTP 500",
  ],
  [
    "a lookup that never reaches the registry",
    { version: "0.9.0", env: { npm_config_registry: unreachable } },
    "could not read @with-logic/elwood@0.9.0 from the registry: lookup-failed ECONNREFUSED",
  ],
  [
    "a registry answer that is not JSON",
    { name: "@with-logic/registry-garbled", version: "1.0.0" },
    "could not read @with-logic/registry-garbled@1.0.0 from the registry: lookup-failed SyntaxError",
  ],
  [
    "a lookup that yields no answer",
    // The decision step printing nothing, as when its output is lost.
    {
      version: "0.1.0",
      prelude:
        'node() { case " $* " in *" --input-type=module "*) return 0 ;; esac; command node "$@"; }',
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

test("a registry that cannot finish its setup exits instead of running on", async () => {
  await assert.rejects(
    startRegistry(join(scratch, "missing")),
    /The local npm registry exited before listening: [\s\S]*ENOENT/u,
  );
});
