/**
 * Coverage for createCodexTranscriptWatcher's `finishSafely` against the REAL
 * bounded watcher (PRD §5.4/§9.2, C-LIFE-10): the final flush drains the last
 * committed record, a THROWING final flush is contained and surfaced as a
 * `final_flush` poll-stopped diagnostic, and `afterFlush` (terminal:exit) always runs.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createCodexTranscriptWatcher } from "../../src/codex/session/transcript.ts";
import type { CodexEventMap } from "../../src/codex/session/types.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";
import { emitSessionWarnings } from "../../src/core/warnings/session.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { tempDirForUnit } from "./helpers.ts";

type Sink = { emitWarnings: (w: readonly ElwoodWarningEvent[]) => void };

/** A wired watcher already observing an empty temp transcript at `path`. */
function wired(getSink: () => Sink | undefined) {
  const emitter = new TypedEmitter<CodexEventMap>();
  const built = createCodexTranscriptWatcher("s1", emitter, getSink);
  const path = join(tempDirForUnit(), "rollout.jsonl");
  writeFileSync(path, "");
  built.watcher.observe(path);
  return { ...built, emitter, path };
}

const record = JSON.stringify({ type: "response_item", payload: { type: "reasoning" } });

describe("createCodexTranscriptWatcher finishSafely (C-LIFE-10)", () => {
  test("runs afterFlush after a successful final flush that drains the last record", () => {
    const kinds: string[] = [];
    const { finishSafely, emitter, path } = wired(() => undefined);
    emitter.on("codex:transcript", (event) => kinds.push(event.summary.kind));
    writeFileSync(path, `${record}\n`);
    let afterRan = false;
    finishSafely(() => {
      afterRan = true;
    });
    expect(afterRan).toBe(true);
    expect(kinds).toEqual(["reasoning"]); // the final drain still surfaced the record
  });

  test("a THROWING final flush still runs afterFlush + routes a final_flush diagnostic", () => {
    const recorded: ElwoodWarningEvent[] = [];
    const sink: Sink = { emitWarnings: (w) => recorded.push(...w) };
    const { finishSafely, watcher, path } = wired(() => sink);
    vi.spyOn(watcher, "flush").mockImplementation(() => {
      throw new Error("final boom");
    });
    writeFileSync(path, `${record}\n`); // drained (and thrown on) by finish()
    let afterRan = false;
    finishSafely(() => {
      afterRan = true;
    });
    expect(afterRan).toBe(true); // terminal:exit emission is NOT skipped
    expect(recorded).toMatchObject([{ code: "transcript_poll_stopped", phase: "final_flush" }]);
  });

  test("C-CODEX-20 first listener failures in the final flush report after record delivery", async () => {
    const order: string[] = [];
    const sink: Sink = {
      emitWarnings: (warnings) =>
        emitSessionWarnings(warnings, {
          warning: (event) => emitter.emit("warning", event),
          activity: (event) => emitter.emit("activity", event),
        }),
    };
    const { finishSafely, emitter, path } = wired(() => sink);
    emitter.on("codex:transcript", () => {
      throw new Error("raw listener");
    });
    emitter.on("activity", () => {
      throw new Error("activity listener");
    });
    emitter.on("activity", (event) => {
      if (event.source === "transcript") order.push("record");
    });
    emitter.on("warning", () => {
      throw new Error("warning listener");
    });
    emitter.on("warning", (event) => order.push(event.code));
    writeFileSync(path, `${record}\n`);
    finishSafely(() => order.push("exit"));
    expect(order).toEqual(["record", "exit"]);
    await Promise.resolve();
    expect(order).toEqual([
      "record",
      "exit",
      "transcript_listener_error",
      "transcript_listener_error",
    ]);
  });

  test("with no afterFlush it is a no-op default", () => {
    const { finishSafely } = wired(() => undefined);
    expect(() => finishSafely()).not.toThrow();
  });
});
