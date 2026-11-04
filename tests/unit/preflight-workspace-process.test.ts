/** Real shell lookups resolve only the selected workspace's CLI (PRD §9.2, C-PERF-02). */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import {
  detectCodexCliCapabilities,
  preflightCodex,
  resetCodexPreflightCacheForTests,
} from "../../src/codex/preflight.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import { probeShellCommand, shellQuote } from "../../src/runtime/shell.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

const adapters = [
  ["claude", preflightClaude],
  ["codex", preflightCodex],
] as const;
beforeEach(() => {
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
  resetAutoupdateForTests();
  setUpdateCoordinatorForTests((_adapter, run) => run());
  setPlatformForTests("darwin");
});
afterEach(() => {
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
});

function installation(version: string, help = "") {
  const root = tempDir("elwood-workspace-cli-");
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const binName = basename(root);
  const bin = join(cwd, binName);
  mkdirSync(bin);
  for (const agent of ["claude", "codex"]) {
    writeFileSync(
      join(bin, agent),
      `#!/bin/sh\ncase "$1" in\n--version) printf '%s\\n' ${shellQuote(version)};;\n--help) printf '%s\\n' ${shellQuote(help)};;\nupdate) /usr/bin/touch ${shellQuote(`.updated-${agent}`)};;\nesac\n`,
      { mode: 0o700 },
    );
  }
  const shell = join(root, "shell");
  writeFileSync(shell, `#!/bin/sh\nPATH="$PWD/${binName}"; export PATH\nexec /bin/sh -c "$4"\n`, {
    mode: 0o700,
  });
  return { cwd, shell };
}

for (const [agent, preflight] of adapters) {
  test(`C-PERF-02 ${agent} checks a CLI available only in its selected workspace`, async () => {
    const first = installation("2.1.144");
    setCommandRunnerForTests((_command, args, options) => runProbe(first.shell, args, options));
    expect((await runProbe(first.shell, probeShellCommand(`command -v ${agent}`))).status).not.toBe(
      0,
    );
    await expect(preflight(false, false, { cwd: first.cwd })).resolves.toBeUndefined();
    const second = installation("0.1.0");
    setCommandRunnerForTests((_command, args, options) => runProbe(second.shell, args, options));
    await expect(preflight(false, false, { cwd: second.cwd })).rejects.toMatchObject({
      code: `${agent}_version_unsupported`,
    });
  });
  test(`C-LIFE-11 ${agent} verification and update use the selected workspace`, async () => {
    const workspace = installation("2.1.144");
    setCommandRunnerForTests((_command, args, options) => runProbe(workspace.shell, args, options));
    await expect(preflight(false, true, { cwd: workspace.cwd })).resolves.toBeUndefined();
    expect(existsSync(join(workspace.cwd, `.updated-${agent}`))).toBe(true);
  });
}

test("C-PERF-02 Codex help answers belong to the selected workspace", async () => {
  for (const [help, supported] of [
    ["--dangerously-bypass-hook-trust", true],
    ["old help", false],
  ] as const) {
    const workspace = installation("2.1.144", help);
    setCommandRunnerForTests((_command, args, options) => runProbe(workspace.shell, args, options));
    expect(await detectCodexCliCapabilities({ cwd: workspace.cwd })).toEqual({
      supportsHookTrustBypass: supported,
    });
  }
});
