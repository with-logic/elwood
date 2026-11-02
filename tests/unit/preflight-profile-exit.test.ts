/** A profile's own exit 96 remains a login-shell warning, not a guard refusal (C-LIFE-11). */
import { appendFileSync, existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { probeShellCommand, userShell } from "../../src/runtime/shell.ts";
import { dir, project, useProbeProjects } from "../helpers/preflight-projects.ts";

useProbeProjects();

test.each([
  ["claude", preflightClaude, "2.1.144"],
  ["codex", preflightCodex, "codex-cli 0.150.0"],
] as const)("C-LIFE-11 %s reports a profile's update-only exit 96", async (agent, preflight, version) => {
  const cwd = project(agent, version);
  const identity = statSync(cwd, { bigint: true });
  appendFileSync(
    join(process.env["HOME"] ?? "", ".profile"),
    `\ncase "$4" in *"exec ${agent} update"*) exit 96;; esac\n`,
  );
  const warning = await preflight(cwd, true, true, identity);
  expect(warning).toMatchObject({ code: "agent_update_failed", errorCode: "login_shell_failed" });
  expect(warning).not.toHaveProperty("updateCwd");
  expect(existsSync(join(cwd, "updated-in"))).toBe(false);
});

test("C-LIFE-11 a real post-profile guard refusal carries its private evidence and cwd", async () => {
  const cwd = project("claude", "2.1.144");
  const identity = statSync(cwd, { bigint: true });
  const replacement = project("claude", "2.1.144");
  const original = join(dir("elwood-update-original-"), "kept");
  writeFileSync(
    join(cwd, "swap-on-login"),
    `rm swap-on-login; mv "$PWD" '${original}'; mv '${replacement}' "$PWD"\n`,
  );
  try {
    const result = await runProbe(userShell(), probeShellCommand("claude update"), {
      cwd,
      identity,
    });
    expect(result).toMatchObject({ started: false, error: { phase: "login_shell", cwd } });
    expect(existsSync(join(cwd, "updated-in"))).toBe(false);
  } finally {
    if (existsSync(original)) {
      renameSync(cwd, replacement);
      renameSync(original, cwd);
    }
  }
});
