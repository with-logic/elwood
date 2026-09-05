/**
 * CLI prompt-input conformance coverage.
 * Covers PRD §12A.1 and C-CLI-04.
 */

import { describe, expect, test } from "vitest";
import { maxPromptBytes, readPromptInput } from "../../src/cli/input.ts";

async function* chunks(...values: readonly (string | Uint8Array)[]) {
  await Promise.resolve();
  for (const value of values) yield value;
}

describe("CLI prompt input", () => {
  test.each([
    { words: ["Review", "this"], stdin: ["diff\n"], expected: "Review this\n\ndiff\n" },
    { words: [], stdin: ["question"], expected: "question" },
    { words: ["question"], stdin: [], expected: "question" },
  ])("C-CLI-04 composes positional and piped input", async ({ words, stdin, expected }) => {
    await expect(readPromptInput(words, { isTTY: false, source: chunks(...stdin) })).resolves.toBe(
      expected,
    );
  });

  test("C-CLI-04 never reads terminal stdin", async () => {
    let read = false;
    async function* terminal() {
      await Promise.resolve();
      read = true;
      yield "ignored";
    }
    await expect(readPromptInput(["hello"], { isTTY: true, source: terminal() })).resolves.toBe(
      "hello",
    );
    expect(read).toBe(false);
  });

  test.each([{ stdin: [] }, { stdin: ["   "] }])("C-CLI-04 rejects whitespace-only input", async ({
    stdin,
  }) => {
    await expect(readPromptInput([], { isTTY: false, source: chunks(...stdin) })).rejects.toThrow(
      /prompt/iu,
    );
  });

  test("C-CLI-04 enforces the UTF-8 cap incrementally", async () => {
    await expect(
      readPromptInput([], {
        isTTY: false,
        source: chunks("x".repeat(maxPromptBytes), "x"),
      }),
    ).rejects.toThrow(/8 MiB/iu);
  });
});
