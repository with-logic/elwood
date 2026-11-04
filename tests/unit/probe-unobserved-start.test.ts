/** Hidden start markers do not discard known command diagnostics (PRD §9.2, C-PERF-05). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { loginShellResolves } from "../../src/cli/request/agent-detect.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { launchTimedOut } from "../../src/runtime/probe/results.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import * as shell from "../../src/runtime/shell.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPreflightCacheForTests();
});

test("C-PERF-05 hidden marker channels retain CLI stderr through typed startup and detection", async () => {
  const home = tempDir("elwood-probe-unobserved-");
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(home, ".bash_profile"),
    `export PATH=${shell.shellQuote(bin)}:/usr/bin:/bin\nprintf FAKE-SECRET-PROFILE >&2\nexec 3>&-\nexec >/dev/null\n`,
  );
  const stderr = "owned-command-stderr\n";
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nprintf 'owned-command-stderr\\n' >&2\nexit 23\n", {
    mode: 0o700,
  });
  vi.stubEnv("HOME", home);
  const result = await runProbe("/bin/bash", shell.probeShellCommand("claude --version", "claude"));
  expect(result.stderr).toBe(stderr);
  expect(JSON.stringify(result)).not.toContain("FAKE-SECRET");
  setCommandRunnerForTests(() => result);
  setPlatformForTests("darwin");
  resetPreflightCacheForTests();
  const failure = await preflightClaude(false, false, { cwd: home }).catch(
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({ code: "claude_start_failed", details: { stderr } });
  expect(failure).toMatchObject({ details: { phase: "command_start_unobserved" } });
  expect(result).toMatchObject({
    status: null,
    error: { phase: "command_start_unobserved", shellStatus: 23 },
  });
  expect(JSON.stringify(failure)).not.toContain("FAKE-SECRET");
  await expect(
    loginShellResolves("claude", { shell: "/bin/bash", cwd: home }),
  ).rejects.toMatchObject({
    code: "no_agent_found",
    message: expect.stringContaining("did not observe the check start"),
  });
});

test("C-PERF-05 an unobserved-start timeout does not claim the command never ran", async () => {
  setCommandRunnerForTests(() => launchTimedOut(60_000, "", "owned stderr"));
  const failure = await loginShellResolves("codex", { shell: "/bin/bash" }).catch(
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({
    code: "no_agent_found",
    message: expect.stringContaining("did not observe the check start"),
  });
  expect(failure).not.toHaveProperty("message", expect.stringContaining("before running"));
});
