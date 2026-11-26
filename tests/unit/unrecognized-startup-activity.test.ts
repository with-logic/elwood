/** Unknown startup snapshots preserve the bound and Unicode text and redact API keys (C-ATTN-06). */
import { expect, test } from "vitest";
import { unrecognizedStartupActivity } from "../../src/core/activity/startup.ts";

const text = (screen: string) => unrecognizedStartupActivity("codex", "session", screen).text;
const key = `sk-proj-${"Ab3_-".repeat(30)}`;

test("C-ATTN-06 keeps the bounded trailing screen without splitting a surrogate pair", () => {
  const screen = `prefix😀${"a".repeat(8191)}\n\n`;
  expect(text(screen)).toBe("a".repeat(8191));
});

test("C-ATTN-06 retains exactly 8192 code units when the cut is a character boundary", () => {
  const tail = "x".repeat(8_192);
  expect(text(`prefix${tail}  \n`)).toBe(tail);
});

test("C-ATTN-06 redacts whole and dot-masked keys, but not short or in-word sk- tokens", () => {
  const screen = [
    "  OPENAI_API_KEY",
    `  ${key}`,
    "",
    "  ANTHROPIC_API_KEY: sk-ant-...Tail2-x_y",
    "  sk-short task-12345678 ask-me",
  ].join("\n");
  expect(text(screen)).toBe(
    [
      "  OPENAI_API_KEY",
      "  sk-[REDACTED]",
      "",
      "  ANTHROPIC_API_KEY: sk-[REDACTED]",
      "  sk-short task-12345678 ask-me",
    ].join("\n"),
  );
});

test("C-ATTN-06 redacts before the bound, so the cut cannot leave a key's tail", () => {
  const filler = "x".repeat(8_100);
  // Cut first, this screen would keep the key's last characters without their `sk-`.
  expect(`  ${key}\n\n${filler}`.length).toBeGreaterThan(8_192);
  expect(text(`  ${key}\n\n${filler}`)).toBe(`  sk-[REDACTED]\n\n${filler}`);
});

test("C-ATTN-06 a whole key needs eight characters after sk-", () => {
  const screen = "  sk-1234567 and sk-12345678 here\n  sk-abcdefg\n\n  sk-abcdefgh\n";
  expect(text(screen)).toBe("  sk-1234567 and sk-[REDACTED] here\n  sk-abcdefg\n\n  sk-[REDACTED]");
  // A short part ending the screen has no row to continue onto.
  expect(text("  sk-abcdefg")).toBe("  sk-abcdefg");
});

test("C-ATTN-06 redacts a key that wraps after its prefix onto rows of letters", () => {
  const wrapped = `sk-proj-${"abcdefghijKLMNOPQRST".repeat(4)}uvwxyz`;
  const screen = [
    "  OPENAI_API_KEY",
    `  ${wrapped.slice(0, 8)}`,
    wrapped.slice(8, 88),
    wrapped.slice(88),
    "",
    "  Press Enter to continue",
  ].join("\n");
  expect(text(screen)).toBe(
    [
      "  OPENAI_API_KEY",
      "  sk-[REDACTED]",
      "[REDACTED]",
      "[REDACTED]",
      "",
      "  Press Enter to continue",
    ].join("\n"),
  );
});

test("C-ATTN-06 redacts a key wrapped inside its sk- prefix", () => {
  expect(text("  OPENAI_API_KEY: s\nk-proj-abcdefgh\n\n  Done")).toBe(
    "  OPENAI_API_KEY: sk-[REDACTED]\n[REDACTED]\n\n  Done",
  );
  expect(text("  OPENAI_API_KEY: sk\n-proj-abcdefgh")).toBe(
    "  OPENAI_API_KEY: sk-[REDACTED]\n[REDACTED]",
  );
  // Joined, the parts must start `sk-` and a key character.
  expect(text("  a s\nkitten\n  sk\n- item")).toBe("  a s\nkitten\n  sk\n- item");
});

test("C-ATTN-06 sk- inside a word never starts a wrapped key", () => {
  expect(text("  use the task-\n  runner\n  a desk\n-proj-abcdefgh")).toBe(
    "  use the task-\n  runner\n  a desk\n-proj-abcdefgh",
  );
});

test("C-ATTN-06 redacts the field of Codex's API-key page, and a key wrapped in a bordered field", () => {
  // The shape of Codex 0.171.0's API-key page at 80 columns, captured with every character
  // replaced: the prefilled key fills one bordered row, cut at the border.
  const field = `│sk-proj-${"Ab3_-".repeat(14)}│`;
  const screen = [`╭API key${"─".repeat(71)}╮`, field, `╰${"─".repeat(78)}╯`].join("\n");
  expect(field).toHaveLength(80);
  expect(text(screen)).toBe(
    [`╭API key${"─".repeat(71)}╮`, "│sk-[REDACTED]│", `╰${"─".repeat(78)}╯`].join("\n"),
  );
  const box = ["╭API key──╮", "│sk-proj-ab│", "│cdefghijk │", "╰─────────╯"].join("\n");
  expect(text(box)).toBe(
    ["╭API key──╮", "│sk-[REDACTED]│", "│[REDACTED] │", "╰─────────╯"].join("\n"),
  );
});

test("C-ATTN-06 a wrapped key continues only while each run is all its row holds", () => {
  expect(text("  sk-proj-abcdefgh\n  Press Enter")).toBe("  sk-[REDACTED]\n  [REDACTED] Enter");
  expect(text("  sk-proj-ab\ncdefgh\n  Press Enter")).toBe(
    "  sk-[REDACTED]\n[REDACTED]\n  [REDACTED] Enter",
  );
  expect(text("  sk-proj-ab\ncdefgh and more\nletters")).toBe(
    "  sk-[REDACTED]\n[REDACTED] and more\nletters",
  );
});

test("C-ATTN-06 a key the agent masked with dots does not continue onto the next row", () => {
  const screen = "│ ANTHROPIC_API_KEY: sk-ant-...Tail2-x_y │\n│ Do you want to use this API key? │";
  expect(unrecognizedStartupActivity("claude", "session", screen).text).toBe(
    "│ ANTHROPIC_API_KEY: sk-[REDACTED] │\n│ Do you want to use this API key? │",
  );
});
