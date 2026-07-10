/**
 * Focused coverage for the shared session-warning recorder.
 * Covers PRD §5.7 and §8.2: dedup into the snapshot, persist on change, emit
 * `warning`+`activity` only on first observation of a warning key.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { transcriptSeedFromWarnings } from "../../src/claude/session-transcript.ts";
import { recordSessionWarnings, type WarningEmit } from "../../src/core/session-warnings.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";
import { createSessionRecord, type SessionRecord } from "../../src/state/store.ts";

function record(): SessionRecord {
  const root = mkdtempSync(join(tmpdir(), "elwood-warn-"));
  return createSessionRecord({ stateDir: root, cwd: root, id: "warn-1" });
}

function dropWarning(count: number): ElwoodWarningEvent {
  return {
    elwoodSessionId: "warn-1",
    agent: "claude",
    source: "terminal",
    code: "transcript_records_dropped",
    severity: "warning",
    message: `Dropped ${count} record(s).`,
    droppedCount: count,
    droppedBytes: count * 10,
    cause: "unparseable",
    transcriptPath: "/tmp/t.jsonl",
    raw: `transcript_records_dropped count=${count}`,
  };
}

function harness() {
  const persisted: SessionRecord[] = [];
  const emitted: string[] = [];
  const emit: WarningEmit = {
    warning: () => emitted.push("warning"),
    activity: () => emitted.push("activity"),
  };
  return { persisted, emitted, emit, persist: (r: SessionRecord) => persisted.push(r) };
}

describe("recordSessionWarnings", () => {
  test("a first warning persists once and emits warning + activity", () => {
    const { persisted, emitted, emit, persist } = harness();
    recordSessionWarnings(record(), [dropWarning(1)], persist, emit);
    expect(persisted).toHaveLength(1);
    expect(emitted).toEqual(["warning", "activity"]);
  });

  test("an identical repeat is de-duplicated: no persist, no emit", () => {
    const { persisted, emitted, emit, persist } = harness();
    const base = record();
    // Seed the snapshot with the warning, then feed the SAME warning again.
    const seeded = { ...base, warnings: [dropWarning(1)] };
    recordSessionWarnings(seeded, [dropWarning(1)], persist, emit);
    expect(persisted).toEqual([]);
    expect(emitted).toEqual([]);
  });

  test("an updated count for the same key persists but does not re-emit", () => {
    const { persisted, emitted, emit, persist } = harness();
    const base = record();
    // Same warning key, higher count: the snapshot changes (persist) but it is
    // not a NEW key, so no duplicate warning/activity event fires.
    const seeded = { ...base, warnings: [dropWarning(1)] };
    recordSessionWarnings(seeded, [dropWarning(9)], persist, emit);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.warnings[0]).toMatchObject({ droppedCount: 9 });
    expect(emitted).toEqual([]);
  });

  test("start→persist→resume→one-more-failure keeps the running total at N+1", () => {
    // Finding B end-to-end at the recorder level: a prior session persisted a
    // droppedCount of 60. On resume the watcher is SEEDED from that snapshot
    // (transcriptSeedFromWarnings), so the first post-resume drop the tracker
    // reports is 61. Feeding that 61-count warning through the recorder persists
    // the new total WITHOUT going backwards to 1 (C-CLAUDE-15).
    const { persisted, emitted, emit, persist } = harness();
    const base = record();
    const seeded = { ...base, warnings: [dropWarning(60)] };
    const seed = transcriptSeedFromWarnings(seeded.warnings);
    expect(seed).toEqual({ drops: { droppedCount: 60, droppedBytes: 600 } });
    // The resumed watcher (seeded to 60) reports 61 on its first drop.
    recordSessionWarnings(seeded, [dropWarning(61)], persist, emit);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.warnings[0]).toMatchObject({ droppedCount: 61 });
    expect(emitted).toEqual([]); // same key, higher count: persist, no re-emit
  });

  test("transcriptSeedFromWarnings derives read-error seed and ignores other codes", () => {
    // Only count-bearing transcript warnings seed the trackers; unrelated codes
    // (e.g. poll_stopped) leave the seed empty for that dimension.
    const readError: ElwoodWarningEvent = {
      elwoodSessionId: "warn-1",
      agent: "claude",
      source: "terminal",
      code: "transcript_read_error",
      severity: "warning",
      message: "contained 4 read error(s)",
      errorCount: 4,
      lastErrorCode: "EISDIR",
      transcriptPath: "/tmp/t.jsonl",
      raw: "transcript_read_error count=4 code=EISDIR",
    };
    const pollStopped: ElwoodWarningEvent = {
      elwoodSessionId: "warn-1",
      agent: "claude",
      source: "terminal",
      code: "transcript_poll_stopped",
      severity: "warning",
      message: "stopped",
      reason: "Error",
      phase: "poll",
      raw: "transcript_poll_stopped reason=Error",
    };
    expect(transcriptSeedFromWarnings([readError, pollStopped])).toEqual({
      readErrors: { errorCount: 4 },
    });
    expect(transcriptSeedFromWarnings([])).toEqual({});
  });

  test("distinct mcp-login warnings for different servers are distinct warning keys", () => {
    const { persisted, emit } = harness();
    const login = (server: string): ElwoodWarningEvent => ({
      elwoodSessionId: "warn-1",
      agent: "codex",
      source: "terminal",
      code: "mcp_server_not_logged_in",
      severity: "warning",
      message: `The ${server} MCP server is not logged in.`,
      mcpServerName: server,
      recoveryCommand: `codex mcp login ${server}`,
      raw: `server=${server}`,
    });
    // Two different servers key differently (on `mcpServerName`), so BOTH persist
    // (not deduped together).
    const warnings = [login("alpha"), login("beta")];
    recordSessionWarnings(record(), warnings, (r) => persisted.push(r), emit);
    expect(persisted.at(-1)?.warnings.map((w) => w.code)).toEqual([
      "mcp_server_not_logged_in",
      "mcp_server_not_logged_in",
    ]);
  });
});
