/**
 * Unit coverage for the login shell fallback when the OS reports no shell.
 * Covers PRD §4.2.
 */

import { describe, expect, test, vi } from "vitest";
import { probeCommandStartLine } from "../../src/runtime/probe/start.ts";
import {
  loginShellCommand,
  probeShellCommand,
  probeShellStatus,
  userShell,
} from "../../src/runtime/shell.ts";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), shell: null }) };
});

describe("user shell", () => {
  test("falls back to /bin/zsh when the platform reports no shell", () => {
    expect(userShell()).toBe("/bin/zsh");
    expect(loginShellCommand("codex")).toEqual(["-l", "-i", "-c", "codex"]);
  });

  test("C-PTY-08 the agent PTY and probes use the same interactive login shell", () => {
    expect(loginShellCommand("claude")).toEqual(["-l", "-i", "-c", "claude"]);
    // Same shell and flags; the probe writes its start line on descriptor 3 if the shell kept
    // it open, then on stdout, and `exec`s the command into its private named pipes
    // (C-PERF-05, §9.2). A builtin's probe answers by status alone, its output discarded.
    const start =
      `if { echo ${probeCommandStartLine} >&3; } 2>/dev/null; then exec 3>&-; fi; ` +
      `{ echo ${probeCommandStartLine}; } 2>/dev/null || :; `;
    expect(probeShellCommand("claude --version")).toEqual([
      "-l",
      "-i",
      "-c",
      `${start}unset -f command_not_found_handler 2>/dev/null || :; ` +
        `exec claude --version >"$ELWOOD_PROBE_OUTPUT/stdout" 2>"$ELWOOD_PROBE_OUTPUT/stderr"`,
    ]);
    expect(probeShellStatus("command -v claude")).toEqual([
      "-l",
      "-i",
      "-c",
      `${start}command -v claude >/dev/null 2>&1`,
    ]);
  });
});
