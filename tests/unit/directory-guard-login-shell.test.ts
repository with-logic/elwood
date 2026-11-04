/** Actual login-shell profiles preserve directory-guard evidence (C-API-61, PRD §9.1). */
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { directoryGuardStopMarker } from "../../src/core/directory-guard.ts";
import { shellQuote } from "../../src/core/shell.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { createStartupBuffer } from "../../src/runtime/startup/buffer.ts";
import { assertStartupUsable } from "../../src/runtime/startup/index.ts";
import { loginShells } from "../helpers/login-shells.ts";
import { tempDir } from "../helpers/tmp.ts";

async function launch(shell: string, replace: boolean) {
  const cwd = realpathSync(tempDir("elwood-login-guard-cwd-"));
  const home = tempDir("elwood-login-guard-home-");
  const moved = join(tempDir("elwood-login-guard-held-"), "original");
  const agent = join(home, "fake-cli");
  const ran = join(home, "agent-ran");
  const { dev, ino } = statSync(cwd, { bigint: true });
  writeFileSync(agent, `#!/bin/sh\n/usr/bin/touch ${shellQuote(ran)}\nexit 96\n`, {
    mode: 0o700,
  });
  const hook = shell.endsWith("zsh")
    ? "TRAPDEBUG() { printf 'profile-debug\\n'; }"
    : "trap \"printf 'profile-debug\\\\n'\" DEBUG";
  const replacement = replace
    ? `/bin/mv ${shellQuote(cwd)} ${shellQuote(moved)}; /bin/mkdir ${shellQuote(cwd)};`
    : ":";
  const profile = `${replacement}\n${hook}\nset -x\n`;
  writeFileSync(join(home, ".zprofile"), profile);
  writeFileSync(join(home, ".bash_profile"), profile);
  const pty = nodePtyFactory({
    command: shell,
    args: ["-l", "-i", "-c", shellQuote(agent)],
    cwd,
    directoryIdentity: { dev, ino },
    env: { ...process.env, HOME: home, ZDOTDIR: home },
    size: { cols: 400, rows: 20 },
  });
  const buffer = createStartupBuffer({
    source: pty,
    capBytes: 8,
    watchStopMarker: false,
    directory: { agent: "claude", cwd, identity: { dev, ino } },
  });
  let output = "";
  pty.onData((chunk) => {
    output += chunk;
  });
  const exit = await new Promise<{ readonly exitCode: number }>((resolve) => pty.onExit(resolve));
  return { cwd, ran, buffer, output, exit };
}

describe.each(loginShells)("C-API-61 actual login shell %s", (shell) => {
  test("DEBUG hooks and xtrace cannot turn an ordinary CLI exit96 into a refusal", async () => {
    const { cwd, ran, buffer, output, exit } = await launch(shell, false);
    try {
      expect(existsSync(ran)).toBe(true);
      expect(output).toContain("profile-debug");
      expect(exit.exitCode).toBe(96);
      const result = await assertStartupUsable({
        adapter: "claude",
        exit,
        output,
        directoryGuard: buffer.directoryGuard,
        waitMs: 0,
      }).catch((error: unknown) => error);
      expect(result).toMatchObject({
        code: "claude_start_failed",
        message: "claude exited during startup.",
        details: { exitCode: 96 },
      });
      expect(result).not.toHaveProperty("details.cwd", cwd);
      expect(output).not.toContain(directoryGuardStopMarker);
      expect(buffer.directoryGuard?.sawMarker()).toBe(false);
    } finally {
      buffer.release();
    }
  });

  test("a profile replacement emits a real refusal past the startup output cap", async () => {
    const { cwd, ran, buffer, output, exit } = await launch(shell, true);
    try {
      expect(existsSync(ran)).toBe(false);
      expect(output).toContain("profile-debug");
      expect(output).toContain(directoryGuardStopMarker);
      expect(buffer.read()).not.toContain(directoryGuardStopMarker);
      expect(buffer.directoryGuard?.sawMarker()).toBe(true);
      await expect(
        assertStartupUsable({
          adapter: "claude",
          exit,
          output,
          directoryGuard: buffer.directoryGuard,
          waitMs: 0,
        }),
      ).rejects.toMatchObject({
        code: "claude_start_failed",
        details: { cwd, exitCode: 96 },
      });
    } finally {
      buffer.release();
    }
  });
});
