/**
 * Canonical CLI record and renderer conformance tests (PRD §12A.3).
 */

import { describe, expect, test } from "vitest";
import { writeJson } from "../../src/cli/output/json.ts";
import { JsonlRenderer } from "../../src/cli/output/jsonl.ts";
import {
  progressFromActivity,
  progressFromTurn,
  progressFromWarning,
} from "../../src/cli/output/records.ts";
import { createCliSanitizer } from "../../src/cli/output/sanitize.ts";
import { StreamingTextRenderer, writeFinalText } from "../../src/cli/output/text.ts";
import type { CliTerminalRecord } from "../../src/cli/output/types.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity.ts";

class Writer {
  value = "";
  write(value: string, callback: (error?: Error | null) => void): boolean {
    this.value += value;
    callback();
    return true;
  }
  once(_event: "drain", _handler: () => void): void {}
}

function terminal(response = "ok"): CliTerminalRecord {
  return {
    schemaVersion: 1,
    type: "result",
    agent: "codex",
    response,
    sessionId: "s1",
    durationMs: 12,
    cleanup: { action: "teardown", status: "succeeded" },
  };
}

describe("CLI output protocols", () => {
  test("C-CLI-10 final and streamed text have exact newline semantics", async () => {
    const finalWriter = new Writer();
    expect(await writeFinalText(new AsyncOutputSink(finalWriter), "ok")).toBe(true);
    expect(finalWriter.value).toBe("ok\n");
    expect(await writeFinalText(new AsyncOutputSink(new Writer()), "")).toBe(true);

    const streamWriter = new Writer();
    const renderer = new StreamingTextRenderer(new AsyncOutputSink(streamWriter));
    expect(await renderer.message("")).toBe(true);
    expect(await renderer.finish()).toBe(true);
    await renderer.message("one");
    await renderer.message("two");
    await renderer.finish();
    expect(streamWriter.value).toBe("one\n\ntwo\n");
  });

  test("C-CLI-11 JSON and JSONL share terminal data and latch one terminal record", async () => {
    const jsonWriter = new Writer();
    await writeJson(new AsyncOutputSink(jsonWriter), terminal());
    expect(JSON.parse(jsonWriter.value)).toEqual(terminal());

    const lines = new Writer();
    const jsonl = new JsonlRenderer(new AsyncOutputSink(lines));
    await jsonl.progress({ schemaVersion: 1, type: "text", text: "ok" });
    await jsonl.finish(terminal());
    expect(await jsonl.progress({ schemaVersion: 1, type: "status", status: "ready" })).toBe(false);
    expect(await jsonl.finish(terminal())).toBe(false);
    const records = lines.value
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toEqual([
      { schemaVersion: 1, type: "text", text: "ok", sequence: 1 },
      { ...terminal(), sequence: 2 },
    ]);
  });

  test("C-CLI-12 projection is fixed-field, sanitized, and never preserves raw", () => {
    const clean = createCliSanitizer(["bridge-secret"]);
    expect(clean("\u001b[31mbridge-secret\u001b[0m\u009b32m!")).toBe("[REDACTED]!");
    expect(progressFromTurn({ type: "text", text: "\u001b[1mok" }, clean)).toEqual({
      schemaVersion: 1,
      type: "text",
      text: "ok",
    });
    expect(progressFromTurn({ type: "thinking", text: "why" }, clean)).toMatchObject({
      type: "thinking",
    });
    expect(progressFromTurn({ type: "tool_call", name: "exec", input: "pwd" }, clean)).toEqual({
      schemaVersion: 1,
      type: "tool",
      phase: "call",
      name: "exec",
      content: "pwd",
    });
    expect(progressFromTurn({ type: "tool_result" }, clean)).toEqual({
      schemaVersion: 1,
      type: "tool",
      phase: "result",
    });
  });

  test("C-CLI-11 lifecycle and warning projections admit only portable fields", () => {
    const activity = {
      kind: "status",
      status: "ready",
      raw: { screen: "secret" },
    } as ElwoodActivityEvent;
    expect(progressFromActivity(activity)).toEqual({
      schemaVersion: 1,
      type: "status",
      status: "ready",
    });
    expect(progressFromActivity({ ...activity, kind: "hook" })).toBeUndefined();
    const projected = progressFromWarning(
      {
        elwoodSessionId: "s1",
        agent: "claude",
        source: "lifecycle",
        code: "version_unparseable",
        severity: "warning",
        message: "\u001b[31mwarning",
        raw: "private",
      },
      createCliSanitizer(),
    );
    expect(projected).toEqual({
      schemaVersion: 1,
      type: "warning",
      code: "version_unparseable",
      message: "warning",
    });
  });
});
