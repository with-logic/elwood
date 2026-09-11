/**
 * Regression coverage for the Codex `Stop` transcript read (PRD §7A.3, C-CODEX-20):
 * every unblocked `Stop` performs one bounded PER-PASS scan, not a terminal drain
 * against the watcher's lifetime 256-chunk budget. Before the fix, each Stop spent
 * one chunk of that budget even on an empty read, so after ~256 turns every later
 * Stop reported a false `unread_backlog` drop and stopped surfacing the turn.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type ElwoodWarningEvent, startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const turns = 300; // comfortably past the 256-chunk terminal budget

describe("CodexSessionApi Stop transcript scan (§7A.3)", () => {
  test("C-CODEX-20 more than 256 Stop hooks never exhaust the terminal budget into false drops", async () => {
    const cwd = tempDir();
    const transcript = join(cwd, "codex.jsonl");
    installFakes();
    writeFileSync(transcript, "");
    const session = await startCodex({ cwd });
    const warnings: ElwoodWarningEvent[] = [];
    const seen: string[] = [];
    session.on("warning", (event) => warnings.push(event));
    session.on("codex:transcript", (event) => seen.push(event.summary.kind));
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "codex-1",
      transcript_path: transcript,
      cwd,
      model: "gpt-5.3-codex",
      source: "startup",
    });
    for (let turn = 0; turn < turns; turn += 1) {
      appendFileSync(
        transcript,
        `${JSON.stringify({ type: "response_item", payload: { type: "reasoning" } })}\n`,
      );
      await ptys[0]!.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "Stop",
        session_id: "codex-1",
        cwd,
        model: "gpt-5.3-codex",
        turn_id: `turn-${turn}`,
        stop_hook_active: false,
      });
    }
    // Every turn's committed record was read by its own Stop scan...
    expect(seen).toHaveLength(turns);
    // ...and no Stop misreported an `unread_backlog` drop (the terminal budget is
    // untouched until finish()).
    expect(warnings.filter((w) => w.code === "transcript_records_dropped")).toEqual([]);
    await session.stop();
  });
});
