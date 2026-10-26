/**
 * After `resetAutoupdateForTests()`, a test's autoupdate refuses to run until the test sets a
 * coordinator of its own, so a unit test can never take the developer's real update lease (PRD
 * §9.2, §12). The production coordinator's default lease root comes from the passwd database,
 * not `HOME`, so the preload's private `HOME` does not keep a test out of it. Here a mocked
 * `node:os` puts that default root under a temp directory, and the test checks the root is never
 * made: without the refusal, the update would run there, never in the real cache.
 */

import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as preloadOnce from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.doUnmock("node:os");
  vi.resetModules();
});

/** Elwood's modules, loaded fresh in a run where the passwd database gives the user `home`. */
async function loadWithUserHome(home: string) {
  vi.doMock("node:os", async (importOriginal) => {
    const os = await importOriginal<typeof import("node:os")>();
    return { ...os, userInfo: () => ({ ...os.userInfo(), homedir: home }) };
  });
  // The preload keeps one update module across module resets, bound to the real `node:os`. This
  // test needs one of its own, bound to the mocked one.
  vi.doUnmock("../../src/runtime/update/once.ts");
  vi.resetModules();
  // In order: the update module binds to this lease module, and each preflight to that update module.
  const lock = await import("../../src/runtime/update/lock.ts");
  const once = await import("../../src/runtime/update/once.ts");
  const seams = await import("../../src/runtime/seams.ts");
  const claude = await import("../../src/claude/preflight.ts");
  const codex = await import("../../src/codex/preflight.ts");
  // Before any update can run: the update module must be a new one, whose lease module's default
  // root is the fake home's, not the real one.
  const root = join(home, "Library", "Caches", "elwood", `${userInfo().uid}-updates`);
  if (once === preloadOnce || lock.updateLockPath("claude") !== join(root, "claude.lock")) {
    throw new Error(`the update module's default lease root is not under ${home}`);
  }
  return {
    preflight: { claude: claude.preflightClaude, codex: codex.preflightCodex },
    once,
    seams,
  };
}

test.each([
  ["Claude", "claude", "2.1.223"],
  ["Codex", "codex", "codex-cli 0.155.0"],
] as const)("a %s preflight after a bare reset refuses to update, and makes no lease root", async (_, adapter, version) => {
  const home = join(tempDir("elwood-fake-user-"), "home");
  const { preflight, once, seams } = await loadWithUserHome(home);
  const commands: string[] = [];
  seams.setPlatformForTests("darwin");
  seams.setCommandRunnerForTests((command, args) => {
    commands.push([command, ...args].join(" "));
    return { status: 0, stdout: version, stderr: "" };
  });
  once.resetAutoupdateForTests();
  await expect(preflight[adapter](false, true)).rejects.toThrow(/^set a private update root/);
  expect(existsSync(home)).toBe(false);
  expect(commands).toEqual([]);
});
