/**
 * The headless CLI's PROCESS-BOUNDARY contract for a turn the agent REJECTED
 * (PRD §12A.3/§12A.5, C-CLI-28): exit status 1 and a terminal error record carrying
 * `turn_failed`, never exit 0 with an empty response — the exact shape issue #19 reported.
 *
 * These drive `executeRun`, so the assertion is the REAL exit code produced by lifecycle
 * failure classification and the rendered terminal record, not an intermediate return value.
 * A session-level test cannot see a regression here: the whole bug was that the failure was
 * invisible at the process boundary.
 */

import { describe, expect, test } from "vitest";
import { executeRun } from "../../src/cli/run/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import { elwoodError } from "../../src/core/errors.ts";
import { effectiveRequest as request } from "./main-fakes.ts";
import { FakeCliSession, FakeSignals, MemoryWriter } from "./run-fakes.ts";

function io() {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  return {
    value: { stdout: new AsyncOutputSink(stdout), stderr: new AsyncOutputSink(stderr) },
    stdout,
    stderr,
  };
}

/** A session whose turn the AGENT rejected: no assistant text, then the typed failure. */
function rejectedSession(): FakeCliSession {
  const session = new FakeCliSession();
  session.events = []; // a rejected turn produces no assistant text
  session.streamWork = () =>
    Promise.reject(
      elwoodError("turn_failed", "You've hit your usage limit.", { info: "usage_limit_exceeded" }),
    );
  return session;
}

describe("C-CLI-28 a rejected turn exits nonzero at the process boundary", () => {
  test("text mode exits 1 with the reason on stderr and an EMPTY stdout", async () => {
    const session = rejectedSession();
    const streams = io();
    // The regression: this used to be exit 0 with empty stdout and empty stderr.
    expect(
      await executeRun(request(), session, streams.value, { signals: new FakeSignals() }),
    ).toBe(1);
    expect(streams.stdout.value).toBe("");
    expect(streams.stderr.value).toBe("elwood: You've hit your usage limit.\n");
  });

  test("json mode exits 1 and emits a terminal error record naming turn_failed", async () => {
    const session = rejectedSession();
    const streams = io();
    expect(
      await executeRun(request({ output: "json" }), session, streams.value, {
        signals: new FakeSignals(),
      }),
    ).toBe(1);
    const record = JSON.parse(streams.stdout.value);
    expect(record.type).toBe("error");
    expect(record.error.code).toBe("turn_failed");
    expect(record.error.message).toBe("You've hit your usage limit.");
    expect(record.response).toBe("");
  });

  test("jsonl mode exits 1 and ENDS in the terminal error record", async () => {
    const session = rejectedSession();
    const streams = io();
    expect(
      await executeRun(request({ output: "jsonl" }), session, streams.value, {
        signals: new FakeSignals(),
      }),
    ).toBe(1);
    const lines = streams.stdout.value.trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1] ?? "null");
    // #19 reported this record as `{"type":"result","response":"",…}` — a reported success.
    expect(last.type).toBe("error");
    expect(last.error.code).toBe("turn_failed");
  });

  test("--stream exits 1 and PRESERVES the partial output already streamed", async () => {
    // The streaming renderer is a separate output path from text/json/jsonl. A turn that emits
    // some text and is THEN rejected must keep what it already streamed (§12A.3 requires
    // `--stream` to preserve partial output on failure) while still failing the run.
    const session = new FakeCliSession();
    session.events = [{ type: "text", text: "partial answer" }];
    session.streamWork = () =>
      Promise.reject(elwoodError("turn_failed", "You've hit your usage limit.", {}));
    const streams = io();
    expect(
      await executeRun(request({ stream: true }), session, streams.value, {
        signals: new FakeSignals(),
      }),
    ).toBe(1);
    expect(streams.stdout.value).toContain("partial answer");
    expect(streams.stderr.value).toBe("elwood: You've hit your usage limit.\n");
  });

  test("§12A.3 a legitimately EMPTY successful turn still exits 0", async () => {
    // The guard against the obvious wrong fix: no assistant text and no adapter failure
    // evidence is a successful empty response, so the CLI must still exit 0.
    const session = new FakeCliSession();
    session.events = [];
    const streams = io();
    expect(
      await executeRun(request(), session, streams.value, { signals: new FakeSignals() }),
    ).toBe(0);
    expect(streams.stdout.value).toBe("");
  });
});
