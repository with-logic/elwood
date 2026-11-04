/** Original launch identities survive version/help cache hits (PRD §9.2, C-PERF-02). */
import { mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { startClaudeWithId } from "../../src/claude/session/index.ts";
import { detectCodexCliCapabilities, preflightCodex } from "../../src/codex/preflight.ts";
import { startCodexWithId } from "../../src/codex/session/index.ts";
import {
  type CommandOptions,
  type CommandRunner,
  setCommandRunnerForTests,
} from "../../src/runtime/seams.ts";
import { checkLaunchDirectory } from "../../src/runtime/session/launch-directory.ts";
import {
  resetAutoupdateForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { fakeLaunch, resetFakeLaunch } from "../helpers/fake-launch.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(resetFakeLaunch);

test.each([
  "claude version",
  "codex version",
  "codex help",
] as const)("C-PERF-02 %s cannot reuse a replacement directory's cached answer", async (kind) => {
  const root = tempDir("elwood-preflight-original-");
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const { dev, ino } = statSync(cwd, { bigint: true });
  const identity = { dev, ino };
  renameSync(cwd, join(root, "original"));
  mkdirSync(cwd);
  fakeLaunch();
  const runner = vi.fn<CommandRunner>((_shell, _args, options) =>
    options?.directoryIdentity?.ino === ino
      ? {
          status: null,
          stdout: "",
          stderr: "",
          error: { origin: "probe_setup" as const, message: "original directory refused" },
        }
      : { status: 0, stdout: "2.1.144 --dangerously-bypass-hook-trust", stderr: "" },
  );
  setCommandRunnerForTests(runner);
  const probe =
    kind === "codex help"
      ? detectCodexCliCapabilities
      : (directory: { readonly cwd: string; readonly identity?: typeof identity }) =>
          (kind === "claude version" ? preflightClaude : preflightCodex)(false, false, directory);
  await probe({ cwd });
  await probe({ cwd });
  expect(runner).toHaveBeenCalledTimes(1);
  await expect(probe({ cwd, identity })).rejects.toMatchObject({
    code: kind === "claude version" ? "claude_start_failed" : "codex_start_failed",
  });
  expect(runner).toHaveBeenCalledTimes(2);
  expect(runner.mock.calls[1]?.[2]).toEqual({ cwd, directoryIdentity: identity });
});

for (const [agent, start] of [
  ["claude", startClaudeWithId],
  ["codex", startCodexWithId],
] as const) {
  test(`C-API-61 ${agent} launch forwards its captured identity through every probe`, async () => {
    fakeLaunch();
    resetAutoupdateForTests();
    setUpdateCoordinatorForTests((_adapter, update) => update());
    const cwd = tempDir("elwood-launch-probe-identity-");
    const directory = await checkLaunchDirectory(agent, cwd);
    const probes: { readonly command: string; readonly options: CommandOptions | undefined }[] = [];
    setCommandRunnerForTests((_shell, args, options) => {
      probes.push({ command: args.join(" "), options });
      return { status: 0, stdout: "2.1.144 --dangerously-bypass-hook-trust", stderr: "" };
    });
    await expect(
      start({ cwd, autoupdate: true }, "pinned-probes", directory),
    ).rejects.toMatchObject({
      code: "pty_start_failed",
      details: { cause: "no PTY in this test" },
    });
    expect(probes.some(({ command }) => command.includes(`${agent} --version`))).toBe(true);
    expect(probes.some(({ command }) => command.includes(`${agent} update`))).toBe(true);
    if (agent === "codex")
      expect(probes.some(({ command }) => command.includes("codex --help"))).toBe(true);
    expect(directory.identity).toBeDefined();
    for (const { options } of probes) {
      expect(options?.cwd).toBe(cwd);
      expect(options?.directoryIdentity).toBe(directory.identity);
    }
  });
}
