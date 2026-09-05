/** Prompt byte-boundary branches for the CLI. Covers PRD C-CLI-04. */

import { describe, expect, test } from "vitest";
import { maxPromptBytes, readPromptInput } from "../../src/cli/input.ts";

async function* source(...chunks: readonly (string | Uint8Array)[]) {
  await Promise.resolve();
  for (const chunk of chunks) yield chunk;
}

const chunkings = [
  ["one chunk", (piped: string) => source(piped)],
  ["many chunks", (piped: string) => source("", piped.slice(0, -1), "", piped.slice(-1))],
] as const;

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

  test.each(
    chunkings,
  )("counts one separator for exact-boundary input in %s", async (_name, chunked) => {
    const piped = "x".repeat(maxPromptBytes - 3);
    await expect(readPromptInput(["a"], { source: chunked(piped) })).resolves.toHaveLength(
      maxPromptBytes,
    );
  });

  test.each(chunkings)("rejects equivalent over-boundary input in %s", async (_name, chunked) => {
    const piped = "x".repeat(maxPromptBytes - 2);
    await expect(readPromptInput(["a"], { source: chunked(piped) })).rejects.toThrow(/8 MiB/iu);
  });

  test("empty chunks never consume the separator budget", async () => {
    await expect(
      readPromptInput(["x".repeat(maxPromptBytes)], { source: source("", "") }),
    ).resolves.toHaveLength(maxPromptBytes);
  });
});
