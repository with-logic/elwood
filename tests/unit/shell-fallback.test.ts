/**
 * Unit coverage for the login shell fallback when the OS reports no shell.
 * Covers PRD §4.2.
 */

import { describe, expect, test, vi } from "vitest";
import { probeCommandStartLine } from "../../src/runtime/probe/start.ts";
import { loginShellCommand, probeShellCommand, userShell } from "../../src/runtime/shell.ts";

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
    // Same shell and flags; the probe writes its start line on descriptor 3 and closes it, or
    // writes it on stdout if the shell already closed descriptor 3, then runs the command
    // (C-PERF-05).
    const line = probeCommandStartLine;
    expect(probeShellCommand("claude --version")).toEqual([
      "-l",
      "-i",
      "-c",
      `if { echo ${line} >&3; } 2>/dev/null; then exec 3>&-; else echo ${line}; fi; claude --version`,
    ]);
  });
});
