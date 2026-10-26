/**
 * Unit coverage for the login shell fallback when the OS reports no shell.
 * Covers PRD §4.2.
 */

import { describe, expect, test, vi } from "vitest";
import { probeCommandEndLine, probeCommandStartLine } from "../../src/runtime/probe/start.ts";
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
    // Same shell and flags; the probe writes its start line on descriptor 3 if the shell kept
    // it open, then on stdout and stderr, runs the command, and brackets it with the end line
    // while keeping its exit status (C-PERF-05, §9.2).
    const [line, end] = [probeCommandStartLine, probeCommandEndLine];
    const status = "elwood_probe_status";
    expect(probeShellCommand("claude --version")).toEqual([
      "-l",
      "-i",
      "-c",
      `if { echo ${line} >&3; } 2>/dev/null; then exec 3>&-; fi; echo ${line}; echo ${line} >&2; ` +
        `{ claude --version\n} && ${status}=0 || ${status}=$?; echo ${end}; echo ${end} >&2; ` +
        `(exit $${status})`,
    ]);
  });
});
