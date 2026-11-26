/**
 * Re-runs the release npm lookup and publication steps with the real npm
 * client, offline, for a version already on npm and for registry lookups that
 * fail. The
 * release-unpublished tests cover a version npm does not have yet.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { startRegistry } from "./npm-registry-fixture.mjs";
import {
  assertFailedWithoutPublishing,
  commitOf,
  retrying,
  usePublishStep,
} from "./release-publish-fixture.mjs";

const { publish, scratch } = usePublishStep();
// Nothing listens here: no listen(0) picks a port below the ephemeral range,
// and fetch, unlike for port 1, does not refuse to try it.
const unreachable = "http://127.0.0.1:1023/";

for (const version of ["0.8.0", "0.7.0"]) {
  test(`a re-run skips ${version}, which this workflow published from the release commit`, () => {
    const { outputs, publishLog, result } = publish({
      version,
      releaseCommit: commitOf[version],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(publishLog, "");
    // The build steps and the upload run only on `publish=true`.
    assert.equal(outputs, "publish=false\n");
    assert.match(
      result.stdout,
      /This workflow already published .*; skipping the build and the upload\./u,
    );
  });
}

// The flaky registry fails a path's first five requests, each a different way.
test("a lookup retries every transient failure, as often as fetch-retries allows", () => {
  const { publishLog, result } = publish({
    name: "@with-logic/elwood-flaky",
    version: "0.8.0",
    releaseCommit: commitOf["0.8.0"],
    env: retrying(5),
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(publishLog, "");
  assert.match(result.stdout, /: published-here\n/u);
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
    `is already on npm, from ${commitOf["0.8.0"]} by a trusted publisher with configuration ID 00000000-0000-4000-8000-000000000000, not NPM_TRUSTED_PUBLISHER_CONFIG_ID; npm never replaces a version`,
  ],
  [
    "a version whose trusted publisher the registry records without a configuration ID",
    { name: "@with-logic/elwood-unrecorded", version: "0.7.0", releaseCommit: commitOf["0.7.0"] },
    `is already on npm, from ${commitOf["0.7.0"]} by a trusted publisher without a readable configuration ID; npm never replaces a version`,
  ],
  [
    // Neither value reaches the log, which could carry a workflow command.
    "a version the registry records with a malformed commit and configuration ID",
    { name: "@with-logic/elwood-unrecorded", version: "0.6.1" },
    "is already on npm, from an unrecorded commit by a trusted publisher without a readable configuration ID; npm never replaces a version",
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
    // Its fifth attempt gets the fifth failure, a 503; a sixth would succeed.
    "a lookup that runs out of retries one short of an answer",
    {
      name: "@with-logic/elwood-flaky",
      version: "0.7.0",
      releaseCommit: commitOf["0.7.0"],
      env: retrying(4),
    },
    "could not read @with-logic/elwood-flaky@0.7.0 from the registry: lookup-failed HTTP 503",
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
    "a registry answer over 16 MiB",
    { name: "@with-logic/registry-oversized", version: "1.0.0" },
    "could not read @with-logic/registry-oversized@1.0.0 from the registry: lookup-failed document over 16777216 bytes",
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
    assertFailedWithoutPublishing(publish(options), reason);
  });
}

test("a registry that cannot finish its setup exits instead of running on", async () => {
  await assert.rejects(
    startRegistry(join(scratch, "missing")),
    /The local npm registry exited before listening: [\s\S]*ENOENT/u,
  );
});
