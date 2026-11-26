/** Unknown startup snapshots preserve the bound and Unicode text and redact API keys (C-ATTN-06, C-ATTN-09). */
import { expect, test } from "vitest";
import { unrecognizedStartupActivity } from "../../src/core/activity/startup.ts";

test("C-ATTN-06 keeps the bounded trailing screen without splitting a surrogate pair", () => {
  const screen = `prefix😀${"a".repeat(8191)}\n\n`;
  expect(unrecognizedStartupActivity("codex", "session", screen).text).toBe("a".repeat(8191));
});

test("C-ATTN-06 retains exactly 8192 code units when the cut is a character boundary", () => {
  const tail = "x".repeat(8_192);
  expect(unrecognizedStartupActivity("codex", "session", `prefix${tail}  \n`).text).toBe(tail);
});

test("C-ATTN-09 redacts API-key-shaped tokens before the bound, both whole and masked", () => {
  const key = `sk-proj-${"Ab3_-".repeat(30)}`;
  const screen = [
    "  OPENAI_API_KEY",
    `  ${key}`,
    "  ANTHROPIC_API_KEY: sk-ant-...Tail2-x_y",
    "  sk-short ask-me",
    "x".repeat(8_192),
  ].join("\n");
  const { text } = unrecognizedStartupActivity(
    "codex",
    "session",
    screen,
    "initial_ready_deadline",
  );
  expect(text).not.toContain("Ab3_-");
  expect(text).not.toContain("Tail2");
  expect(unrecognizedStartupActivity("codex", "session", screen.slice(0, -8_193)).text).toBe(
    "  OPENAI_API_KEY\n  sk-[redacted]\n  ANTHROPIC_API_KEY: sk-[redacted]\n  sk-short ask-me",
  );
});

test("C-ATTN-09 redacts a key the terminal wrapped onto following rows, and nothing after it", () => {
  const key = `sk-proj-${"Ab3_-".repeat(20)}`;
  const screen = [
    "  OPENAI_API_KEY",
    `  ${key.slice(0, 38)}`,
    key.slice(38, 78),
    `${key.slice(78)}`,
    "  Press Enter to continue",
    "│ ANTHROPIC_API_KEY: sk-ant-...Tail2-x_y │",
    "│ Do you want to use this API key?        │",
  ].join("\n");
  expect(unrecognizedStartupActivity("codex", "session", screen).text).toBe(
    [
      "  OPENAI_API_KEY",
      "  sk-[redacted]",
      "[redacted]",
      "[redacted]",
      "  Press Enter to continue",
      "│ ANTHROPIC_API_KEY: sk-[redacted] │",
      "│ Do you want to use this API key?        │",
    ].join("\n"),
  );
});
