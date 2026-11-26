/**
 * Runs the release workflow's Publish to npm step against the local npm
 * registry (npm-registry-fixture.mjs) for the release publish tests. Each
 * `npm publish` is recorded and run for real as a dry run, so npm's own
 * version and dist-tag checks still apply.
 */

// biome-ignore-all lint/suspicious/noMisplacedAssertion: Failure tests call this check inside their test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";

import { startRegistry } from "./npm-registry-fixture.mjs";
import { runStep } from "./release-fixture.mjs";

// The recorded releases: this workflow's trusted publisher published 0.7.0 and
// 0.8.0 (`latest`), and a maintainer published 0.1.0 by hand.
export const commitOf = {
  "0.1.0": "d8b4e78e0d6979f6a081689fcbb42987a2c66d7f",
  "0.7.0": "5ac725b514fe26d1ef71a837f029c8f6fd15c4d3",
  "0.8.0": "86b962487b962a1c8ff628aee7ad45fc527a386e",
};
const otherCommit = "0".repeat(40);
const handPublisher = "maintainer@example.test";

/** Returns npm's retry settings for `retries` retries, with a 1 ms wait. */
export const retrying = (retries) => ({
  npm_config_fetch_retries: String(retries),
  npm_config_fetch_retry_mintimeout: "1",
});

const dryRunPublish =
  'npm() { if [ "$1" = publish ]; then echo "$*" >> "$PUBLISH_LOG"; command npm "$@" --dry-run; else command npm "$@"; fi; }';

/**
 * Starts the local registry for the calling test file, and returns its
 * scratch directory, `publish()`, which runs the step for one package, and
 * `npmPublishDryRun()`, which runs npm's own dry-run publish for one, without
 * the step.
 */
export function usePublishStep() {
  const scratch = mkdtempSync(join(tmpdir(), "elwood-release-publish-"));
  let registry;
  before(async () => {
    registry = await startRegistry(scratch);
  });
  after(() => {
    registry?.stop();
    rmSync(scratch, { recursive: true, force: true });
  });
  function packageDirectory(name, version) {
    const cwd = mkdtempSync(join(scratch, "package-"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name, version }));
    return cwd;
  }
  function publish({
    name = "@with-logic/elwood",
    version,
    releaseCommit = otherCommit,
    prelude = "",
    env = {},
  }) {
    const cwd = packageDirectory(name, version);
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
    return { publishLog: readFileSync(log, "utf8"), result };
  }
  function npmPublishDryRun({ name = "@with-logic/elwood", version }) {
    return spawnSync("npm", ["publish", "--access", "public", "--dry-run"], {
      cwd: packageDirectory(name, version),
      encoding: "utf8",
      env: { ...process.env, ...registry.env },
    });
  }
  return { npmPublishDryRun, publish, scratch };
}

/** Asserts that a step failed on an `::error::` line ending in `reason`, without publishing. */
export function assertFailedWithoutPublishing({ publishLog, result }, reason) {
  assert.equal(result.status, 1);
  assert.equal(publishLog, "");
  const errorLines = result.stdout.split("\n").filter((line) => line.startsWith("::error::"));
  assert.ok(
    errorLines.some((line) => line.endsWith(reason)),
    result.stdout,
  );
  // The registry's publisher email stays out of the log.
  assert.ok(!`${result.stdout}${result.stderr}`.includes(handPublisher), result.stdout);
}
