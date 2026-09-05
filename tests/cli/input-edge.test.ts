/** Prompt byte-boundary branches for the CLI. Covers PRD C-CLI-04. */

import { describe, expect, test } from "vitest";
import { maxPromptBytes, readPromptInput } from "../../src/cli/input.ts";

async function* source(...chunks: readonly (string | Uint8Array)[]) {
  await Promise.resolve();
  for (const chunk of chunks) yield chunk;
}

describe("CLI prompt byte edges", () => {
  test("accepts bytes at the exact cap and Uint8Array chunks", async () => {
    await expect(
      readPromptInput([], { source: source(Uint8Array.from(Buffer.from("ok"))) }),
    ).resolves.toBe("ok");
    await expect(
      readPromptInput(["x".repeat(maxPromptBytes)], { isTTY: true, source: source() }),
    ).resolves.toHaveLength(maxPromptBytes);
  });

  test("rejects positional input above the cap", async () => {
    await expect(
      readPromptInput(["x".repeat(maxPromptBytes + 1)], { isTTY: true, source: source() }),
    ).rejects.toThrow(/8 MiB/iu);
  });

  test("counts a separator only once across empty chunks", async () => {
    await expect(readPromptInput(["a"], { source: source("", "b") })).resolves.toBe("a\n\nb");
  });
});
