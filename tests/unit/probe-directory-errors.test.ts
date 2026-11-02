/** Directory-stat failures retain the filesystem errno and checked path (C-ERR-08, C-PTY-08). */
import { appendFileSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import {
  currentCommandRunner,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";
import { assertLaunchDirectory } from "../../src/runtime/session/launch-directory.ts";
import { dir, project, useProbeProjects } from "../helpers/preflight-projects.ts";

useProbeProjects();

test.each([
  ["claude", startClaude, "2.1.144 (Claude Code)"],
  ["codex", startCodex, "codex-cli 0.150.0"],
] as const)("C-ERR-08 %s keeps a transient stat EACCES when the same directory becomes readable again", async (agent, start, version) => {
  const parent = dir("elwood-private-stat-");
  const cwd = join(parent, "project");
  renameSync(project(agent, version), cwd);
  const real = currentCommandRunner();
  setCommandRunnerForTests(async (command, args, options) => {
    setCommandRunnerForTests(real);
    chmodSync(parent, 0o000);
    try {
      return await real(command, args, options);
    } finally {
      chmodSync(parent, 0o700);
    }
  });
  await expect(start({ cwd })).rejects.toMatchObject({
    code: `${agent}_start_failed`,
    details: { cwd, errno: "EACCES", cause: expect.stringContaining("EACCES") },
  });
});

test.each([
  126, 127,
])("C-ERR-08 a valid login shell's own exit %s stays a shell failure", async (status) => {
  appendFileSync(join(process.env["HOME"] ?? "", ".profile"), `\nexit ${status}\n`);
  const cwd = project("claude", "2.1.144 (Claude Code)");
  await expect(startClaude({ cwd })).rejects.toMatchObject({
    code: "claude_start_failed",
    details: {
      cwd,
      phase: "login_shell",
      cause: `login shell exited with status ${status} before starting the probe command`,
    },
  });
});

test("C-API-61 an unsupported host preserves preflight precedence over a missing cwd", async () => {
  setPlatformForTests("linux");
  await expect(assertLaunchDirectory("claude", "/missing")).resolves.toBeUndefined();
  await expect(startClaude({ cwd: "/missing" })).rejects.toMatchObject({
    code: "unsupported_platform",
  });
});
