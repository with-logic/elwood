/** Actual PTY refusal survives restoring the original workspace (C-API-61, PRD §9.1). */
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import {
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import * as shell from "../../src/runtime/shell.ts";
import {
  resetStartupWaitMsForTests,
  setStartupWaitMsForTests,
} from "../../src/runtime/startup/index.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { resumableStateDir } from "../helpers/session-state.ts";
import { tempDir } from "../helpers/tmp.ts";

const observed = vi.hoisted(() => ({ windowMs: 123_456, exit: Promise.resolve() }));
vi.mock("../../src/core/delay.ts", async (original) => {
  const actual = await original<typeof import("../../src/core/delay.ts")>();
  return { delay: (ms: number) => (ms === observed.windowMs ? observed.exit : actual.delay(ms)) };
});
beforeEach(() => {
  setStartupWaitMsForTests(observed.windowMs);
  setPlatformForTests("darwin");
  setCommandRunnerForTests(() => ({
    status: 0,
    stdout: "2.1.144 (Claude Code) codex-cli 0.150.0",
    stderr: "",
  }));
});
afterEach(() => {
  resetStartupWaitMsForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
});
const agents = [
  ["claude", startClaude, resumeClaude],
  ["codex", startCodex, resumeCodex],
] as const;
for (const kind of ["start", "resume"] as const) {
  test.each(
    agents,
  )(`C-API-61 ${kind} of %s identifies a refusal after original cwd restoration`, async (agent, start, resume) => {
    const cwd = realpathSync(tempDir("elwood-restored-cwd-"));
    const held = join(tempDir("elwood-held-cwd-"), "original");
    const replacement = tempDir("elwood-new-cwd-");
    const home = tempDir("elwood-restore-home-");
    const login = join(home, "shell");
    const cliMarker = join(home, "agent-ran");
    writeFileSync(login, '#!/bin/sh\n. "$HOME/.profile"\nshift 3\neval "$1"\n', { mode: 0o700 });
    writeFileSync(
      join(home, ".profile"),
      `mv '${cwd}' '${held}'\nmv '${replacement}' '${cwd}'\nexec >/dev/null 2>&1\n`,
    );
    mkdirSync(join(replacement, "bin"));
    writeFileSync(join(replacement, "bin", agent), `#!/bin/sh\ntouch '${cliMarker}'\n`, {
      mode: 0o700,
    });
    vi.stubEnv("HOME", home);
    vi.spyOn(shell, "userShell").mockReturnValue(login);
    const exit = Promise.withResolvers<void>();
    observed.exit = exit.promise;
    setPtyFactoryForTests((options) => {
      const pty = nodePtyFactory(options);
      pty.onExit(() => {
        renameSync(cwd, replacement);
        renameSync(held, cwd);
        exit.resolve();
      });
      return pty;
    });
    const stateDir =
      kind === "resume"
        ? resumableStateDir(agent, cwd, "restore-refusal")
        : tempDir("elwood-restore-state-");
    const launch =
      kind === "resume"
        ? resume({ stateDir, elwoodSessionId: "restore-refusal" })
        : start({ cwd, stateDir });
    await expect(launch).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      message: `${agent} did not start: the launch directory failed verification. Keep the workspace available and unchanged, then retry.`,
      details: { cwd, exitCode: 96 },
    });
    expect(existsSync(held)).toBe(false);
    expect(existsSync(cliMarker)).toBe(false);
  });
}

test.each(
  agents,
)("C-API-61 %s exiting96 without a guard marker remains an agent failure", async (agent, start) => {
  const cwd = realpathSync(tempDir("elwood-agent96-cwd-"));
  const home = tempDir("elwood-agent96-home-");
  const login = join(home, "shell");
  const cliMarker = join(home, "agent-ran");
  mkdirSync(join(cwd, "bin"));
  writeFileSync(join(cwd, "bin", agent), `#!/bin/sh\ntouch '${cliMarker}'\nexit 96\n`, {
    mode: 0o700,
  });
  writeFileSync(login, `#!/bin/sh\nexport PATH='${cwd}/bin:/usr/bin:/bin'\nshift 3\neval "$1"\n`, {
    mode: 0o700,
  });
  vi.stubEnv("HOME", home);
  vi.spyOn(shell, "userShell").mockReturnValue(login);
  const exit = Promise.withResolvers<void>();
  observed.exit = exit.promise;
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory(options);
    pty.onExit(() => exit.resolve());
    return pty;
  });
  const result = await start({ cwd, stateDir: tempDir("elwood-agent96-state-") }).catch(
    (error: unknown) => error,
  );
  expect(result).toMatchObject({
    code: `${agent}_start_failed`,
    message: `${agent} exited during startup.`,
    details: { exitCode: 96 },
  });
  expect(result).not.toHaveProperty("details.cwd");
  expect(existsSync(cliMarker)).toBe(true);
});
