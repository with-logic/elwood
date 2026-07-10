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
    // Valid survives round-trip; a non-numeric count is rejected, not coerced.
    expect(validateSessionRecord({ ...record, warnings: [warning] }, root, id)).not.toBeNull();
    expect(
      validateSessionRecord({ ...record, warnings: [{ ...warning, droppedCount: "3" }] }, root, id),
    ).toBeNull();
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
    expect(
      validateSessionRecord({ ...record, warnings: [{ ...warning, errorCount: "2" }] }, root, id),
    ).toBeNull();
  });
});
