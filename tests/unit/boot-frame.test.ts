/** A CLI's header drawn alone while it loads is a startup screen (PRD §5.4, C-ATTN-09). */
import { expect, test } from "vitest";
import { claudeBootFrame } from "../../src/claude/session/readiness.ts";
import { nativeBootFrame } from "../../src/runtime/readiness/boot-frame.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const codexBootFrame = nativeBootFrame(/>_ OpenAI Codex \(v\d+\.\d+\.\d+/);

test.each([
  ["Claude 2.1.310's banner before its composer", "claude-2.1.310/trust-slow-boot/banner-only"],
  ["Claude 2.1.332's text-style picker", "claude-2.1.332/startup/theme-picker"],
] as const)("C-ATTN-09 %s", (_, path) => {
  expect(claudeBootFrame(capturedFrame(path))).toBe(path.endsWith("banner-only"));
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
