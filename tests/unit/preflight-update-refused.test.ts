/** An update refused before exec is forgotten, without a false warning or cwd (C-LIFE-11). */
import { beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";

beforeEach(() => {
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  setPlatformForTests("darwin");
  setUpdateCoordinatorForTests((_adapter, update) => update());
});

for (const [agent, preflight, version] of [
  ["claude", preflightClaude, "2.1.144"],
  ["codex", preflightCodex, "codex-cli 0.150.0"],
] as const) {
  test.each([
    "host",
    "child",
  ] as const)(`C-LIFE-11 a %s-refused ${agent} update is not cached and sends no false warning`, async (where) => {
    const updates: string[] = [];
    setCommandRunnerForTests((_command, args, options) => {
      if (!args.at(-1)?.includes(`exec ${agent} update`))
        return { status: 0, stdout: version, stderr: "" };
      updates.push(options?.cwd ?? "");
      if (updates.length > 1) return { status: 0, stdout: "", stderr: "" };
      const reason =
        where === "host"
          ? { message: "stat refused", code: "ENOENT", cwd: "/one" }
          : ({ message: "guard refused", phase: "login_shell", cwd: "/one" } as const);
      return { started: false, status: null, stdout: "", stderr: "", error: reason };
    });
    const outcomes = await Promise.all([
      preflight("/one", false, true),
      preflight("/two", false, true),
    ]);
    expect(outcomes).toEqual([undefined, undefined]);
    expect(updates).toEqual(["/one", "/two"]);
    await expect(preflight("/three", false, true)).resolves.toBeUndefined();
    expect(updates).toEqual(["/one", "/two"]);
  });
}
