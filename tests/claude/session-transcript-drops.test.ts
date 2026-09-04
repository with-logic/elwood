/**
 * Session-level wiring of Claude transcript drop diagnostics.
 * Covers PRD §5.4/§5.7 (C-CLAUDE-15): an unparseable committed record surfaces
 * a live `transcript_records_dropped` warning through the warning contract.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("C-CLAUDE-15 Claude transcript drop wiring", () => {
  test("a malformed committed record surfaces a live drop warning", async () => {
    const cwd = tempDir();
    const stateDir = join(tempDir(), "state");
    installFakes();
    const session = await startClaude({ cwd, stateDir });
    const warnings: string[] = [];
    session.on("warning", (event) => warnings.push(event.code));
    // A Stop hook carries a transcript with one unparseable record. The watcher
    // routes the drop through the session's warning sink, so it is emitted as a
    // live `warning` event (not raw activity, never persisted).
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
  });

  test("C-LIFE-10 a listener throwing on the final flush still yields exit + status + reap", async () => {
    // Finding 6: the PTY-exit callback flushes the trailing committed transcript
    // before emitting terminal:exit. If a transcript activity listener throws during
    // that flush, the exit event, terminal status, and process-group reap MUST still
    // run (behind the error boundary), and a bounded diagnostic is surfaced.
    const cwd = tempDir();
    const stateDir = join(tempDir(), "state");
    installFakes();
    const session = await startClaude({ cwd, stateDir });
    const warnings: string[] = [];
    const exits: number[] = [];
    session.on("warning", (event) => warnings.push(event.code));
    session.on("terminal:exit", (event) => exits.push(event.exitCode));
    // A downstream activity consumer that throws on committed transcript activity —
    // a programming bug in a parent app's listener during the final flush.
    session.on("activity", (event) => {
      if (event.kind === "assistant_message") throw new Error("listener bug during flush");
    });
    // Observe the transcript via a Stop hook while the file is still EMPTY: the
    // cursor baselines at EOF (0) and nothing is emitted during the hook.
    const transcriptPath = join(cwd, "transcript.jsonl");
    writeFileSync(transcriptPath, "");
    await ptys[0]!.dispatchHook(
      session.elwoodSessionId,
      { hook_event_name: "Stop", session_id: "claude-1", cwd, transcript_path: transcriptPath },
      stateDir,
    );
    // Append a committed assistant reply AFTER the baseline: it stays unread until
    // the final flush at exit (the poll interval is unref'd and does not fire in
    // this synchronous test), so the throw happens inside finishSafely().
    const reply = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "committed reply" }] },
    });
    writeFileSync(transcriptPath, `${reply}\n`);
    const leaderPid = ptys.at(-1)!.pid;
    reapedGroups.length = 0;
    // The natural exit flushes the appended record; emitting it throws through the
    // listener, but the error boundary contains it so termination still completes.
    ptys.at(-1)!.emitExit({ exitCode: 0 });
    expect(exits).toEqual([0]); // terminal:exit still emitted
    expect(session.status).toBe("exited"); // terminal status still reached
    expect(reapedGroups).toContain(leaderPid); // group still reaped (no leak)
    await expect.poll(() => warnings).toContain("transcript_poll_stopped");
  });
});
