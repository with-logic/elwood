/**
 * Validation round-trip coverage for the Claude transcript diagnostic warnings.
 * Covers PRD §5.7/§8.2 (C-CLAUDE-15): transcript_records_dropped and
 * transcript_read_error survive persist→resume and reject malformed shapes.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createSessionRecord } from "../../src/state/store.ts";
import { validateSessionRecord } from "../../src/state/validate.ts";

const id = "validate-target";

function base(): { root: string; record: Record<string, unknown> } {
  const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
  const record = createSessionRecord({ stateDir: root, cwd: root, id });
  return { root, record: JSON.parse(JSON.stringify(record)) as Record<string, unknown> };
}

describe("C-CLAUDE-15 transcript warning validation", () => {
  test("accepts and gates the transcript_records_dropped warning", () => {
    const { root, record } = base();
    const warning = {
      elwoodSessionId: id,
      agent: "claude",
      source: "terminal",
      code: "transcript_records_dropped",
      severity: "warning",
      message: "Dropped 3 record(s).",
      droppedCount: 3,
      droppedBytes: 42,
      transcriptPath: "/tmp/t.jsonl",
      raw: "count=3",
    };
    // Valid survives round-trip; a count must be a POSITIVE safe integer, so a
    // non-numeric, negative, fractional, OR zero droppedCount is rejected.
    expect(validateSessionRecord({ ...record, warnings: [warning] }, root, id)).not.toBeNull();
    for (const bad of ["3", -1, 1.5, 0]) {
      expect(
        validateSessionRecord(
          { ...record, warnings: [{ ...warning, droppedCount: bad }] },
          root,
          id,
        ),
      ).toBeNull();
    }
    // droppedBytes may be 0 (a zero-byte dropped line is possible), so it is NOT
    // gated as positive — only as a non-negative integer.
    expect(
      validateSessionRecord({ ...record, warnings: [{ ...warning, droppedBytes: 0 }] }, root, id),
    ).not.toBeNull();
  });

  test("accepts and gates the transcript_read_error warning", () => {
    const { root, record } = base();
    const warning = {
      elwoodSessionId: id,
      agent: "claude",
      source: "terminal",
      code: "transcript_read_error",
      severity: "warning",
      message: "Contained 2 read error(s) (last: EISDIR).",
      errorCount: 2,
      lastErrorCode: "EISDIR",
      transcriptPath: "/tmp/t.jsonl",
      raw: "count=2",
    };
    expect(validateSessionRecord({ ...record, warnings: [warning] }, root, id)).not.toBeNull();
    // errorCount must be a positive safe integer: string, zero, negative, and
    // fractional are all rejected.
    for (const bad of ["2", 0, -3, 2.5]) {
      expect(
        validateSessionRecord({ ...record, warnings: [{ ...warning, errorCount: bad }] }, root, id),
      ).toBeNull();
    }
  });

  test("accepts and gates the transcript_poll_stopped warning", () => {
    const { root, record } = base();
    const warning = {
      elwoodSessionId: id,
      agent: "claude",
      source: "terminal",
      code: "transcript_poll_stopped",
      severity: "warning",
      message: "Transcript polling stopped after an unexpected error.",
      reason: "ENOENT",
      raw: "reason=ENOENT",
    };
    expect(validateSessionRecord({ ...record, warnings: [warning] }, root, id)).not.toBeNull();
    // The reason is validated against the SAME allowlist the producer draws from,
    // so a non-numeric reason AND a non-allowlisted (possibly conversation-derived)
    // string are both rejected rather than round-tripped.
    for (const bad of [5, "boom", "leakedPromptText"]) {
      expect(
        validateSessionRecord({ ...record, warnings: [{ ...warning, reason: bad }] }, root, id),
      ).toBeNull();
    }
  });

  test("C-LIFE-10 accepts and gates the reap_failed lifecycle warning", () => {
    const { root, record } = base();
    const warning = {
      elwoodSessionId: id,
      agent: "claude",
      source: "lifecycle",
      code: "reap_failed",
      severity: "warning",
      message: "Could not reap PTY process group 4242 after exit (EPERM).",
      processGroupId: 4242,
      errorCode: "EPERM",
      raw: "reap_failed pgid=4242 code=EPERM",
    };
    const one = (w: object) => validateSessionRecord({ ...record, warnings: [w] }, root, id);
    expect(one(warning)).not.toBeNull(); // valid claude lifecycle reap_failed
    expect(one({ ...warning, agent: "codex" })).not.toBeNull(); // valid under codex too
    expect(one({ ...warning, source: "terminal" })).toBeNull(); // wrong source
    expect(one({ ...warning, processGroupId: "4242" })).toBeNull(); // non-integer pgid
    expect(one({ ...warning, processGroupId: 1.5 })).toBeNull(); // fractional pgid
    // A real PTY leader pid is a safe integer > 1, so 0, 1, negatives, and unsafe
    // integers are all rejected rather than persisted.
    for (const bad of [0, 1, -5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(one({ ...warning, processGroupId: bad })).toBeNull();
    }
    expect(one({ ...warning, errorCode: 5 })).toBeNull(); // non-string code
    // A non-allowlisted (possibly conversation-derived) errorCode is rejected.
    expect(one({ ...warning, errorCode: "leakedSecretToken" })).toBeNull();
    expect(one({ ...warning, agent: "gemini" })).toBeNull(); // unknown agent
  });
});
