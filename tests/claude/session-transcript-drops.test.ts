/**
 * Session-level wiring of Claude transcript drop diagnostics.
 * Covers PRD §5.4/§5.7 (C-CLAUDE-15): an unparseable committed record surfaces
 * a persisted `transcript_records_dropped` warning through the warning contract.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("C-CLAUDE-15 Claude transcript drop wiring", () => {
  test("a malformed committed record surfaces a persisted drop warning", async () => {
    const cwd = tempDir();
    const stateDir = join(tempDir(), "state");
    installFakes();
    const session = await startClaude({ cwd, stateDir });
    const warnings: string[] = [];
    session.on("warning", (event) => warnings.push(event.code));
    // A Stop hook carries a transcript with one unparseable record. The watcher
    // routes the drop through the session's warning sink, so it is emitted as a
    // `warning` event AND persisted into the session snapshot (not raw activity).
    const transcriptPath = join(cwd, "transcript.jsonl");
    // A committed turn (user boundary) followed by an unparseable assistant line:
    // baseline recovery reaches the malformed record after the user boundary.
    const userRecord = JSON.stringify({ type: "user", message: { content: "go" } });
    writeFileSync(transcriptPath, `${userRecord}\n{ not valid json }\n`);
    await ptys[0]!.dispatchHook(
      session.elwoodSessionId,
      { hook_event_name: "Stop", session_id: "claude-1", cwd, transcript_path: transcriptPath },
      stateDir,
    );
    expect(warnings).toEqual(["transcript_records_dropped"]);
    expect(session.warnings.map((w) => w.code)).toContain("transcript_records_dropped");
  });
});
