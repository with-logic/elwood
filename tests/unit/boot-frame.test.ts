/** A CLI's header drawn alone while it loads is a startup screen (PRD §5.4, C-ATTN-09). */
import { expect, test } from "vitest";
import { claudeBootFrame } from "../../src/claude/session/readiness.ts";
import { codexBootFrame } from "../../src/codex/session/readiness.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

test.each([
  [
    "Claude 2.1.310's banner before its composer",
    "claude-2.1.310/trust-slow-boot/banner-only",
    true,
  ],
  ["Claude 2.1.332's text-style picker", "claude-2.1.332/startup/theme-picker", false],
] as const)("C-ATTN-09 %s", (_, path, boot) => {
  expect(claudeBootFrame(capturedFrame(path))).toBe(boot);
});

test.each([
  ["Codex 0.172.0's header over its logo", "codex-0.172.0/update/start-boot-partial", true],
  ["the same header under a passive notice", "codex-0.172.0/update/start-notice-partial", true],
  ["a boot composer, with a placeholder", "codex-0.164.0/boot/boot-composer", false],
  ["Codex 0.171.0's sign-in screen", "codex-0.171.0/startup/sign-in", false],
] as const)("C-ATTN-09 %s", (_, path, boot) => {
  expect(codexBootFrame(capturedFrame(path))).toBe(boot);
});

test.each([
  ["a numbered choice", "  1. Yes"],
  ["a key hint", "  Press Enter to continue"],
  ["a yes/no question", "  Continue? (y/n)"],
])("C-ATTN-09 a header with %s is not a boot frame", (_, row) => {
  expect(claudeBootFrame(` ▐▛███▛█   Claude Code v2.1.332\n${row}`)).toBe(false);
});

test("C-ATTN-09 a frame with nothing to answer but no header of the agent's is not a boot frame", () => {
  expect(claudeBootFrame("  Loading your workspace\n  Please wait")).toBe(false);
  expect(codexBootFrame("  Loading your workspace\n  Please wait")).toBe(false);
});

test.each([
  [
    "Claude's banner",
    claudeBootFrame,
    "claude-2.1.310/trust-slow-boot/banner-only",
    "/tmp/ELWOOD_CAPTURE/project",
  ],
  [
    "Codex's header",
    codexBootFrame,
    "codex-0.172.0/update/start-boot-partial",
    "/tmp/elwood-update-CAPTURE",
  ],
] as const)("C-ATTN-09 %s over a workspace path of hint words is still a boot frame", (_, bootFrame, path, cwd) => {
  const frame = capturedFrame(path).replace(cwd, "~/src/continue/press/enter/esc/cancel/confirm");
  expect(frame).toContain("/continue/");
  expect(bootFrame(frame)).toBe(true);
});

test("C-ATTN-09 a header over a prompt that ends in a caret is not a boot frame", () => {
  expect(claudeBootFrame(" ▐▛███▛█   Claude Code v2.1.332\n  Paste code here if prompted >")).toBe(
    false,
  );
});
