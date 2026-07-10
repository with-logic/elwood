/**
 * Focused coverage for the shared session-warning recorder.
 * Covers PRD §5.7 and §8.2: dedup into the snapshot, persist on change, emit
 * `warning`+`activity` only on first observation of a warning key.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
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

  test("distinct trust_prompt_unanswerable prompts are distinct warning keys", () => {
    const { persisted, emit } = harness();
    const unanswerable = (prompt: string): ElwoodWarningEvent => ({
      elwoodSessionId: "warn-1",
      agent: "claude",
      source: "terminal",
      code: "trust_prompt_unanswerable",
      severity: "warning",
      message: `no option for ${prompt}`,
      prompt,
      raw: `prompt=${prompt}`,
    });
    // Two different prompts key differently, so BOTH persist (not deduped together).
    const warnings = [unanswerable("skill_trust"), unanswerable("plugin_trust")];
    recordSessionWarnings(record(), warnings, (r) => persisted.push(r), emit);
    expect(persisted.at(-1)?.warnings.map((w) => w.code)).toEqual([
      "trust_prompt_unanswerable",
      "trust_prompt_unanswerable",
    ]);
  });
});
