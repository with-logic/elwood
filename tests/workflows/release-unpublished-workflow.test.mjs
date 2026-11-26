/**
 * Runs the release npm publication step with the real npm client, offline,
 * for a version npm does not have yet: it publishes unless a newer release
 * overtook it, in which case npm would refuse to move `latest` back, or the
 * package's packument cannot be read or has no versions object.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertFailedWithoutPublishing,
  retrying,
  usePublishStep,
} from "./release-publish-fixture.mjs";

const { npmPublishDryRun, publish } = usePublishStep();

// npm, publishing as a dry run, agrees that each can take `latest`.
for (const [label, options] of [
  ["a version newer than every one on npm", { version: "0.9.0" }],
  ["a version whose minor version has two digits", { version: "0.10.0" }],
  ["the first version of a package", { name: "@with-logic/elwood-new", version: "1.0.0" }],
  [
    "a version newer than every stable, undeprecated one",
    { name: "@with-logic/elwood-deprecated", version: "0.6.2" },
  ],
  [
    // Each path fails five times, as `interruptions` lists, then answers.
    "a version whose lookup and packument read each need every retry",
    { name: "@with-logic/elwood-flaky", version: "0.9.0", env: retrying(5) },
  ],
]) {
  test(`${label} publishes`, () => {
    const { publishLog, result } = publish(options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(publishLog, "publish --access public\n");
    assert.match(result.stdout, /: unpublished\n/u);
  });
}

const implicitLatest = (newer, version) =>
  `Cannot implicitly apply the "latest" tag because previously published version ${newer} is higher than the new version ${version}.`;
// Each row: the newer version the step names, and the refusal npm gives.
const overtaken = [
  [
    "a version a newer release overtook",
    { version: "0.6.2" },
    "0.8.0",
    implicitLatest("0.8.0", "0.6.2"),
  ],
  [
    // npm refuses any prerelease that names no dist-tag, before it compares.
    "a prerelease of a version on npm",
    { version: "0.8.0-rc.1" },
    "0.8.0",
    "You must specify a tag using --tag when publishing a prerelease version.",
  ],
  [
    "a version a newer major version overtook, named over a higher minor version",
    { name: "@with-logic/elwood-major", version: "0.9.0" },
    "1.0.0",
    implicitLatest("1.0.0", "0.9.0"),
  ],
];

// The step stops each before npm would, so this pins npm's own refusal.
for (const [label, options, , refusal] of overtaken) {
  test(`npm itself refuses to publish ${label} as latest`, () => {
    const result = npmPublishDryRun(options);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(refusal), result.stderr);
  });
}

const overtakenError = (package_, newer) =>
  `${package_} is older than ${newer}, which is already on npm, so it cannot take the latest dist-tag. To ship it anyway, publish it by hand with an explicit dist-tag: npm publish --access public --tag <tag>`;
const malformedError = (name) =>
  `could not read ${name}@1.0.0 from the registry: lookup-failed a packument without a versions object`;
for (const [label, options, reason] of [
  ...overtaken.map(([label, options, newer]) => [
    label,
    options,
    overtakenError(`${options.name ?? "@with-logic/elwood"}@${options.version}`, newer),
  ]),
  [
    "a package lookup that fails once the version is not found",
    { name: "@with-logic/packument-down", version: "1.0.0" },
    "could not read @with-logic/packument-down@1.0.0 from the registry: lookup-failed HTTP 500 reading the packument",
  ],
  ...[
    ["a null packument", "@with-logic/packument-null"],
    ["a packument without versions", "@with-logic/packument-unversioned"],
    ["a packument whose versions are an array", "@with-logic/packument-listed"],
  ].map(([label, name]) => [label, { name, version: "1.0.0" }, malformedError(name)]),
]) {
  test(`${label} fails the step without publishing`, () => {
    assertFailedWithoutPublishing(publish(options), reason);
  });
}
