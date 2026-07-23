/**
 * Focused coverage for the shared live-only session-warning emitter.
 * Covers PRD §5.7: a warning is emitted ONCE when observed as a `warning` + its
 * `activity`, with the two emits isolated so one throwing listener does not suppress
 * the other. No persistence, no dedup, no running count.
 */

import { describe, expect, test } from "vitest";
import { emitSessionWarnings, type WarningEmit } from "../../src/core/session-warnings.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";

function dropWarning(): ElwoodWarningEvent {
  return {
    elwoodSessionId: "warn-1",
    agent: "claude",
    source: "terminal",
    code: "transcript_records_dropped",
    severity: "warning",
    message: "Dropped an unparseable transcript record.",
    cause: "unparseable",
    transcriptPath: "/tmp/t.jsonl",
    raw: "transcript_records_dropped cause=unparseable",
  };
}

function readErrorWarning(): ElwoodWarningEvent {
  return {
    elwoodSessionId: "warn-1",
    agent: "claude",
    source: "terminal",
    code: "transcript_read_error",
    severity: "warning",
    message: "Contained a transcript read error.",
    lastErrorCode: "ENOENT",
    transcriptPath: "/tmp/t.jsonl",
    raw: "transcript_read_error code=ENOENT",
  };
}

function harness() {
  const emitted: string[] = [];
  const emit: WarningEmit = {
    warning: () => emitted.push("warning"),
    activity: () => emitted.push("activity"),
  };
  return { emitted, emit };
}

describe("emitSessionWarnings", () => {
  test("each warning emits warning + activity once, in order", () => {
    const { emitted, emit } = harness();
    emitSessionWarnings([dropWarning(), dropWarning()], emit);
    expect(emitted).toEqual(["warning", "activity", "warning", "activity"]);
  });

  test("an empty list emits nothing", () => {
    const { emitted, emit } = harness();
    emitSessionWarnings([], emit);
    expect(emitted).toEqual([]);
  });

  test("a throwing warning listener still lets activity fire, then rethrows the first error", () => {
    const emitted: string[] = [];
    const boom = new Error("warning boom");
    const emit: WarningEmit = {
      warning: () => {
        throw boom;
      },
      activity: () => emitted.push("activity"),
    };
    expect(() => emitSessionWarnings([dropWarning()], emit)).toThrow(boom);
    expect(emitted).toEqual(["activity"]); // the activity still fired despite the throw
  });

  test("a throwing activity listener rethrows after both emits are attempted", () => {
    const emitted: string[] = [];
    const boom = new Error("activity boom");
    const emit: WarningEmit = {
      warning: () => emitted.push("warning"),
      activity: () => {
        throw boom;
      },
    };
    expect(() => emitSessionWarnings([dropWarning()], emit)).toThrow(boom);
    expect(emitted).toEqual(["warning"]);
  });

  test("a throwing FIRST warning does not drop LATER warnings in the same batch", () => {
    // The regression for the review's "one listener failure drops later warnings"
    // finding: warning #1's listener throws, but warning #2 (whose identity was already
    // consumed upstream and can't be recovered) must STILL be delivered. The first error
    // is rethrown only after the whole batch fired.
    const delivered: string[] = [];
    const boom = new Error("first warning boom");
    let firstWarning = true;
    const emit: WarningEmit = {
      warning: (w) => {
        if (firstWarning) {
          firstWarning = false;
          throw boom;
        }
        delivered.push(w.code);
      },
      activity: () => undefined,
    };
    expect(() => emitSessionWarnings([dropWarning(), readErrorWarning()], emit)).toThrow(boom);
    expect(delivered).toEqual(["transcript_read_error"]); // the SECOND warning still delivered
  });

  test("the FIRST listener error wins when both listeners throw", () => {
    const warningErr = new Error("warning boom");
    const emit: WarningEmit = {
      warning: () => {
        throw warningErr;
      },
      activity: () => {
        throw new Error("activity boom");
      },
    };
    expect(() => emitSessionWarnings([dropWarning()], emit)).toThrow(warningErr);
  });
});
