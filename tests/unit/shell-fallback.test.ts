/**
 * Unit coverage for the login shell fallback when the OS reports no shell.
 * Covers PRD §4.2.
 */

import { describe, expect, test, vi } from "vitest";
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

  test("C-PTY-08 the agent PTY uses an interactive login shell; probes are login-only", () => {
    // PTY launch keeps -i (matches Terminal.app); one-shot probes drop it.
    expect(loginShellCommand("claude")).toEqual(["-l", "-i", "-c", "claude"]);
    expect(probeShellCommand("claude --version")).toEqual(["-l", "-c", "claude --version"]);
    expect(probeShellCommand("claude --version")).not.toContain("-i");
  });
});
