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
  vi.resetModules();
  const [claude, codex, lock, once, seams] = await Promise.all([
    import("../../src/claude/preflight.ts"),
    import("../../src/codex/preflight.ts"),
    import("../../src/runtime/update/lock.ts"),
    import("../../src/runtime/update/once.ts"),
    import("../../src/runtime/seams.ts"),
  ]);
  // Before any update can run: the default lease root must be the fake home's, not the real one.
  const root = join(home, "Library", "Caches", "elwood", `${userInfo().uid}-updates`);
  if (lock.updateLockPath("claude") !== join(root, "claude.lock")) {
    throw new Error(`the default lease root is not under ${home}`);
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
