/**
 * Every test starts with autoupdates refused until it sets an update coordinator of its own
 * (PRD §9.2, §12): the preload resets the update module as it loads, keeps that one module for a
 * re-import after `vi.resetModules()`, and resets it again after every test.
 *
 * The tests run in order. The first sees the state the update module loaded with. The second
 * sets a coordinator, and checks only that it replaces the refusal. The third sees what the
 * preload's reset after the second leaves, and the fourth re-imports the preflight. Each of the
 * first, third and fourth checks that the refusing coordinator is the active one, and only then
 * runs a preflight with autoupdate on, so a broken preload fails that check before any update
 * could reach the developer's real lease root.
 */

import { afterEach, expect, test, vi } from "vitest";
import * as claude from "../../src/claude/preflight.ts";
import * as seams from "../../src/runtime/seams.ts";
import * as once from "../../src/runtime/update/once.ts";

afterEach(() => {
  vi.resetModules();
});

type Elwood = {
  readonly claude: typeof claude;
  readonly once: typeof once;
  readonly seams: typeof seams;
};

/**
 * Checks that `elwood`'s updates are refused, and only then runs a Claude preflight with
 * autoupdate on: what it rejected with, and the commands it ran.
 */
async function preflightIfRefused(elwood: Elwood) {
  if (!elwood.once.updatesRefusedForTests()) {
    throw new Error("the update coordinator is not the refusing one: no preflight was run");
  }
  const commands: string[] = [];
  elwood.seams.setPlatformForTests("darwin");
  elwood.seams.setCommandRunnerForTests((command, args) => {
    commands.push([command, ...args].join(" "));
    return { status: 0, stdout: "2.1.223", stderr: "" };
  });
  const error = await elwood.claude.preflightClaude(false, true).then(
    () => "resolved",
    (rejection: unknown) => String(rejection),
  );
  return { error, commands };
}

/** What a preflight run by `preflightIfRefused` gives when the refusal stops it. */
const refused = {
  error: expect.stringMatching(/^Error: set a private update root/),
  commands: [],
};

test("a test file's first test starts with updates refused", async () => {
  expect(await preflightIfRefused({ claude, once, seams })).toEqual(refused);
});

test("a coordinator a test sets replaces the refusal", () => {
  once.setUpdateCoordinatorForTests((_adapter, update) => update());
  expect(once.updatesRefusedForTests()).toBe(false);
});

test("the next test starts with updates refused again", async () => {
  expect(await preflightIfRefused({ claude, once, seams })).toEqual(refused);
});

test("a re-import after vi.resetModules() starts with updates refused", async () => {
  vi.resetModules();
  // The update module first, so the preflight loaded after it is bound to this one instance.
  const preloadOnce = await import("../../src/runtime/update/once.ts");
  const freshSeams = await import("../../src/runtime/seams.ts");
  const fresh = await import("../../src/claude/preflight.ts");
  // The preflight is loaded anew. The update module it is bound to is the preload's, which a
  // module reset does not replace, so it is still refusing.
  expect(fresh === claude).toBe(false);
  expect(await preflightIfRefused({ claude: fresh, once: preloadOnce, seams: freshSeams })).toEqual(
    refused,
  );
});
