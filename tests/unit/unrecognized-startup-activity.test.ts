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
    "",
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
    "  OPENAI_API_KEY\n  sk-[redacted]\n\n  ANTHROPIC_API_KEY: sk-[redacted]\n  sk-short ask-me",
  );
});

test("C-ATTN-09 a whole key needs eight characters after sk-", () => {
  const screen = "  sk-1234567 and sk-12345678 here\n  sk-abcdefg\n\n  sk-abcdefgh\n";
  expect(unrecognizedStartupActivity("codex", "session", screen).text).toBe(
    "  sk-1234567 and sk-[redacted] here\n  sk-abcdefg\n\n  sk-[redacted]",
  );
  // A short part ending the screen has no row to continue onto.
  expect(unrecognizedStartupActivity("codex", "session", "  sk-abcdefg").text).toBe("  sk-abcdefg");
});

test("C-ATTN-09 redacts a key that wraps after its prefix onto rows of letters", () => {
  const key = `sk-proj-${"abcdefghijKLMNOPQRST".repeat(4)}uvwxyz`;
  const screen = [
    "  OPENAI_API_KEY",
    `  ${key.slice(0, 8)}`,
    key.slice(8, 88),
    key.slice(88),
    "",
    "  Press Enter to continue",
  ].join("\n");
  expect(unrecognizedStartupActivity("codex", "session", screen).text).toBe(
    [
      "  OPENAI_API_KEY",
      "  sk-[redacted]",
      "[redacted]",
      "[redacted]",
      "",
      "  Press Enter to continue",
    ].join("\n"),
  );
});

test("C-ATTN-09 redacts the field of Codex's API-key page, and the word after a row-ending key", () => {
  // The shape of Codex's API-key page at 80 columns, probed with every character masked: the
  // prefilled key fills one bordered row, cut at the border.
  const field = `│sk-proj-${"Ab3_-".repeat(14)}│`;
  const screen = [`╭API key${"─".repeat(71)}╮`, field, `╰${"─".repeat(78)}╯`].join("\n");
  expect(field).toHaveLength(80);
  expect(unrecognizedStartupActivity("codex", "session", screen).text).toBe(
    [`╭API key${"─".repeat(71)}╮`, "│sk-[redacted]│", `╰${"─".repeat(78)}╯`].join("\n"),
  );
  expect(
    unrecognizedStartupActivity("codex", "session", "  sk-proj-abcdefgh\n  Press Enter").text,
  ).toBe("  sk-[redacted]\n  [redacted] Enter");
});

test("C-ATTN-09 a key the agent masked with dots does not continue onto the next row", () => {
  const screen = "│ ANTHROPIC_API_KEY: sk-ant-...Tail2-x_y │\n│ Do you want to use this API key? │";
  expect(unrecognizedStartupActivity("claude", "session", screen).text).toBe(
    "│ ANTHROPIC_API_KEY: sk-[redacted] │\n│ Do you want to use this API key? │",
  );
});
