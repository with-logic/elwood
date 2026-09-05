/**
 * Exhaustive optional-field and closed-output edges for CLI renderers (PRD §12A.3).
 */

import { describe, expect, test } from "vitest";
import { JsonlRenderer } from "../../src/cli/output/jsonl.ts";
import { progressFromTurn } from "../../src/cli/output/records.ts";
import { createCliSanitizer } from "../../src/cli/output/sanitize.ts";
import { StreamingTextRenderer, writeFinalText } from "../../src/cli/output/text.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";

class ClosedWriter {
  write(_value: string, callback: (error?: Error | null) => void): boolean {
    callback(Object.assign(new Error("closed"), { code: "EPIPE" }));
    return true;
  }
  once(_event: "drain", _handler: () => void): void {}
}

describe("CLI output edges", () => {
  test("optional tool fields are independently projected", () => {
    const clean = createCliSanitizer();
    expect(progressFromTurn({ type: "tool_call", name: "read" }, clean)).toEqual({
      schemaVersion: 1,
      type: "tool",
      phase: "call",
      name: "read",
    });
    expect(progressFromTurn({ type: "tool_result", name: "read", output: "done" }, clean)).toEqual({
      schemaVersion: 1,
      type: "tool",
      phase: "result",
      name: "read",
      content: "done",
    });
  });

  test("closed sinks suppress all later text and JSONL output", async () => {
    const sink = new AsyncOutputSink(new ClosedWriter());
    expect(await writeFinalText(sink, "first")).toBe(false);
    expect(await writeFinalText(sink, "later")).toBe(false);
    const text = new StreamingTextRenderer(sink);
    expect(await text.message("later")).toBe(false);
    expect(await text.finish()).toBe(false);
    const jsonl = new JsonlRenderer(sink);
    expect(await jsonl.progress({ schemaVersion: 1, type: "thinking", text: "x" })).toBe(false);
    expect(
      await jsonl.finish({
        schemaVersion: 1,
        type: "error",
        agent: null,
        response: "",
        sessionId: null,
        durationMs: 0,
        cleanup: { action: "preserve", status: "failed", error: "failed" },
        error: { code: "runtime_error", message: "failed" },
      }),
    ).toBe(false);
  });
});
