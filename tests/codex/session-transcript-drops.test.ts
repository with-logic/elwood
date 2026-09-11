/**
 * Integration coverage for the Codex transcript drop→warning wiring (PRD §5.4):
 * an oversized un-terminated transcript record is discarded by the bounded cursor
 * and surfaces through the LIVE session as a content-free `transcript_records_dropped`
 * warning. Exercises the real `createCodexTranscriptWatcher` sink resolution in
 * `session/index.ts` end-to-end (not the mocked-watcher unit path).
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type ElwoodWarningEvent, startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

// A record larger than the cursor's 1 MiB pending ceiling, with NO trailing newline,
// so the bounded cursor discards it as an over-length un-terminated record.
const OVERSIZED_RECORD = `{"junk":"${"x".repeat(1_100_000)}"`;

describe("CodexSessionApi transcript drops (§5.4)", () => {
  test("§5.4 an oversized transcript record surfaces a content-free drop warning on the session", async () => {
    const cwd = tempDir();
    const transcript = join(cwd, "codex.jsonl");
    installFakes();
    writeFileSync(transcript, "");
    const session = await startCodex({ cwd });
    const warnings: ElwoodWarningEvent[] = [];
    session.on("warning", (event) => warnings.push(event));
    // Start observing the transcript, then write an over-length record with no newline.
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "codex-1",
      transcript_path: transcript,
      cwd,
      model: "gpt-5.3-codex",
      source: "startup",
    });
    appendFileSync(transcript, OVERSIZED_RECORD);
    // The exit path finishes the watcher, whose bounded final drain discards the
    // oversized pending record and fires the drop notice through the session sink.
    ptys[0]!.emitExit({ exitCode: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnings.map((w) => w.code)).toContain("transcript_records_dropped");
    // The warning is content-free: it carries a cause/path, never the record bytes.
    const dropped = warnings.find((w) => w.code === "transcript_records_dropped");
    expect(dropped).toBeDefined();
    expect(JSON.stringify(dropped)).not.toContain("xxxxx");
  });
});
