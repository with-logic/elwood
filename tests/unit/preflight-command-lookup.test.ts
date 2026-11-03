/** A resolved CLI’s exit127 differs from confirmed lookup failure (PRD §9.2/§10, C-PERF-05). */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import { probeShellCommand } from "../../src/runtime/shell.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => vi.unstubAllEnvs());
for (const [agent, preflight] of [
  ["claude", preflightClaude],
  ["codex", preflightCodex],
] as const) {
  test.each([
    "control",
    "stdout",
  ])(`C-PERF-05 ${agent} preserves resolved CLI status127 via %s`, async (channel) => {
    const bin = tempDir("elwood-cli-exit127-");
    const cli = join(bin, agent);
    writeFileSync(cli, "#!/bin/sh\nprintf 'resolved CLI failed\\n' >&2\nexit 127\n");
    chmodSync(cli, 0o700);
    vi.stubEnv("PATH", bin);
    setPlatformForTests("darwin");
    resetPreflightCacheForTests();
    setCommandRunnerForTests((_shell, args) =>
      runProbe("/bin/sh", ["-c", `${channel === "stdout" ? "exec 3>&-; " : ""}${args[3]}`]),
    );
    await expect(preflight(false)).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      details: { exitStatus: 127, stderr: "resolved CLI failed\n" },
    });
  });

  test.each([
    "control",
    "stdout",
  ])(`C-PERF-05 ${agent} reports confirmed missing lookup via %s`, async (channel) => {
    vi.stubEnv("PATH", tempDir("elwood-cli-missing-"));
    setPlatformForTests("darwin");
    resetPreflightCacheForTests();
    const probe = (args: readonly string[]) =>
      runProbe("/bin/sh", ["-c", `${channel === "stdout" ? "exec 3>&-; " : ""}${args[3]}`]);
    const result = await probe(probeShellCommand(`${agent} --version`, agent));
    expect(result).toMatchObject({
      status: 127,
      commandLookupFailed: true,
      stdout: "",
      stderr: "",
    });
    setCommandRunnerForTests((_shell, args) => probe(args));
    const error = await preflight(false).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: `${agent}_not_found`,
      details: {
        exitStatus: 127,
        cause: `The login shell found no \`${agent}\` (status 127).`,
      },
    });
    expect(error).not.toHaveProperty("details.stderr");
  });
}
