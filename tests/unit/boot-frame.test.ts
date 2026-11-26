/** A CLI's header drawn alone while it loads is a startup screen (PRD §5.4, C-ATTN-11). */
import { expect, test } from "vitest";
import { isClaudeBootFrame } from "../../src/claude/session/readiness.ts";
import { isCodexBootFrame } from "../../src/codex/session/readiness.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

test.each([
  [
    "Claude 2.1.310's banner before its composer",
    "claude-2.1.310/trust-slow-boot/banner-only",
    true,
  ],
  ["Claude 2.1.332's text-style picker", "claude-2.1.332/startup/theme-picker", false],
] as const)("C-ATTN-11 %s", (_, path, boot) => {
  expect(isClaudeBootFrame(capturedFrame(path))).toBe(boot);
});

test.each([
  ["Codex 0.172.0's header over its logo", "codex-0.172.0/update/start-boot-partial", true],
  ["the same header under a passive notice", "codex-0.172.0/update/start-notice-partial", true],
  ["a boot composer, with a placeholder", "codex-0.164.0/boot/boot-composer", false],
  ["Codex 0.171.0's sign-in screen", "codex-0.171.0/startup/sign-in", false],
] as const)("C-ATTN-11 %s", (_, path, boot) => {
  expect(isCodexBootFrame(capturedFrame(path))).toBe(boot);
});

// Each row but the first matches one form of answerable row alone.
test.each([
  ["a key hint", "  Press Enter to continue"],
  ["a caret-led choice", "  ❯ Light mode"],
  ["a numbered choice", "  1. Yes"],
  ["a parenthesized number", "  2) Dark mode"],
  ["an Enter hint", "  Enter to select"],
  ["an Esc hint", "  Esc to skip"],
  ["a Tab hint", "  Tab to switch theme"],
  ["a Press hint", "  Press any key"],
  ["a bare confirm hint", "  Type y to confirm"],
  ["a bare cancel hint", "  Ctrl+C to cancel"],
  ["a bare continue hint", "  Pick a theme to continue"],
  ["a yes/no question", "  Continue? (y/n)"],
])("C-ATTN-11 a header with %s is not a boot frame", (_, row) => {
  expect(isClaudeBootFrame(` ▐▛███▛█   Claude Code v2.1.332\n${row}`)).toBe(false);
});

test("C-ATTN-11 a frame with nothing to answer but no header of the agent's is not a boot frame", () => {
  expect(isClaudeBootFrame("  Loading your workspace\n  Please wait")).toBe(false);
  expect(isCodexBootFrame("  Loading your workspace\n  Please wait")).toBe(false);
});

test.each([
  [
    "Claude's banner",
    isClaudeBootFrame,
    "claude-2.1.310/trust-slow-boot/banner-only",
    "/tmp/ELWOOD_CAPTURE/project",
  ],
  [
    "Codex's header",
    isCodexBootFrame,
    "codex-0.172.0/update/start-boot-partial",
    "/tmp/elwood-update-CAPTURE",
  ],
] as const)("C-ATTN-11 %s over a workspace path of hint words is still a boot frame", (_, bootFrame, path, cwd) => {
  const frame = capturedFrame(path).replace(cwd, "~/src/continue/press/enter/esc/cancel/confirm");
  expect(frame).toContain("/continue/");
  expect(bootFrame(frame)).toBe(true);
});

test("C-ATTN-11 a header over a prompt that ends in a caret is not a boot frame", () => {
  expect(
    isClaudeBootFrame(" ▐▛███▛█   Claude Code v2.1.332\n  Paste code here if prompted >"),
  ).toBe(false);
});
