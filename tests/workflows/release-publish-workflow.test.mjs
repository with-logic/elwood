/** Re-runs the release npm publication step against the real npm registry. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { runStep } from "./release-fixture.mjs";

const scratch = mkdtempSync(join(tmpdir(), "elwood-release-publish-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// What actions/setup-node writes for `registry-url: https://registry.npmjs.org`.
const npmrc = join(scratch, "npmrc");
writeFileSync(
  npmrc,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: npm expands this npmrc placeholder.
  "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\nregistry=https://registry.npmjs.org/\n",
);
const npmEnv = {
  NODE_AUTH_TOKEN: "XXXXX-XXXXX-XXXXX-XXXXX",
  npm_config_cache: join(scratch, "npm-cache"),
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_update_notifier: "false",
  npm_config_userconfig: npmrc,
};

// Real releases, as the registry records them: this workflow published 0.7.0
// through trusted publishing, and a maintainer published 0.1.0 by hand.
const fromWorkflow = { version: "0.7.0", commit: "5ac725b514fe26d1ef71a837f029c8f6fd15c4d3" };
const byHand = { version: "0.1.0", commit: "d8b4e78e0d6979f6a081689fcbb42987a2c66d7f" };

// The registry answers every lookup; only `npm publish` itself is stubbed.
const recordPublish =
  'npm() { if [ "$1" = publish ]; then echo "$*" >> "$PUBLISH_LOG"; else command npm "$@"; fi; }';

function publish(name, version, releaseCommit) {
  const cwd = join(scratch, name);
  mkdirSync(cwd);
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "@with-logic/elwood", version }));
  const log = join(cwd, "publish.log");
  writeFileSync(log, "");
  const result = runStep("name: Publish to npm", {
    cwd,
    env: { ...npmEnv, PUBLISH_LOG: log, RUNNER_TEMP: cwd },
    expressions: {
      "needs.resolve.outputs.version": version,
      "needs.secret-scan.outputs.commit": releaseCommit,
    },
    prelude: recordPublish,
  });
  return { publishes: readFileSync(log, "utf8"), result };
}

test("a re-run skips a version this workflow already published from the release commit", () => {
  const live = spawnSync(
    "npm",
    ["view", `@with-logic/elwood@${fromWorkflow.version}`, "gitHead", "_npmUser.email", "--json"],
    { encoding: "utf8", env: { ...process.env, ...npmEnv } },
  );
  assert.equal(
    live.stdout.replaceAll(/\s/gu, ""),
    `{"gitHead":"${fromWorkflow.commit}","_npmUser.email":"npm-oidc-no-reply@github.com"}`,
    `This test needs registry.npmjs.org to report how 0.7.0 was published: ${live.stderr}`,
  );

  const { publishes, result } = publish("from-workflow", fromWorkflow.version, fromWorkflow.commit);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(publishes, "");
  assert.match(result.stdout, /This workflow already published @with-logic\/elwood@0\.7\.0 from/u);
});

for (const [label, version, releaseCommit] of [
  ["an unpublished version", "0.0.0-never-published", fromWorkflow.commit],
  ["a version published from another commit", fromWorkflow.version, "0".repeat(40)],
  ["a version a maintainer published by hand", byHand.version, byHand.commit],
]) {
  test(`${label} goes to npm publish`, () => {
    const { publishes, result } = publish(label.replaceAll(" ", "-"), version, releaseCommit);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(publishes, "publish --access public\n");
  });
}

test("the step logs what the registry reported before it publishes", () => {
  const { result } = publish("logged", "0.0.0-never-published", fromWorkflow.commit);
  assert.match(
    result.stdout,
    /^Registry lookup for @with-logic\/elwood@0\.0\.0-never-published: gitHead=none publisher=none \(code E404\)$/mu,
  );
});
