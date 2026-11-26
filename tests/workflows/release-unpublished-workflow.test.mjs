/**
 * Runs the release npm publication step with the real npm client, offline,
 * for a version npm does not have yet: it publishes unless a newer release
 * overtook it, in which case npm would refuse to move `latest` back, or the
 * package's packument cannot be read or has no versions object.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { assertFailedWithoutPublishing, usePublishStep } from "./release-publish-fixture.mjs";

const { publish } = usePublishStep();

// npm, publishing as a dry run, agrees that each can take `latest`.
for (const [label, options] of [
  ["a version newer than every one on npm", { version: "0.9.0" }],
  ["a version whose minor version has two digits", { version: "0.10.0" }],
  ["the first version of a package", { name: "@with-logic/elwood-new", version: "1.0.0" }],
  [
    "a version newer than every stable, undeprecated one",
    { name: "@with-logic/elwood-deprecated", version: "0.6.2" },
  ],
]) {
  test(`${label} publishes`, () => {
    const { publishes, result } = publish(options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(publishes, "publish --access public\n");
    assert.match(result.stdout, /: unpublished\n/u);
  });
}

const overtakenError = (package_, newer = "0.8.0") =>
  `${package_} is older than ${newer}, which is already on npm, so it cannot take the latest dist-tag. To ship it anyway, publish it by hand with an explicit dist-tag: npm publish --access public --tag <tag>`;
const malformedError = (name) =>
  `could not read ${name}@1.0.0 from the registry: lookup-failed a packument without a versions object`;
for (const [label, options, reason] of [
  [
    "a version a newer release overtook",
    { version: "0.6.2" },
    overtakenError("@with-logic/elwood@0.6.2"),
  ],
  [
    "a prerelease of a version on npm",
    { version: "0.8.0-rc.1" },
    overtakenError("@with-logic/elwood@0.8.0-rc.1"),
  ],
  [
    "a version a newer major version overtook, named over a higher minor version",
    { name: "@with-logic/elwood-major", version: "0.9.0" },
    overtakenError("@with-logic/elwood-major@0.9.0", "1.0.0"),
  ],
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
