/** Fixed redraw, scrolling, snapshot and transcript traffic for PRD §9.2 profiling. */
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Executable benchmark correctness checks.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { createFleet } from "./runtime.ts";

type Fleet = Awaited<ReturnType<typeof createFleet>>;
const transcriptEveryRounds = 8; // 80 rounds produce ten transcript events per session.

function progress(round: number, codex: boolean) {
  return codex
    ? {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: `progress-${round}`,
        },
      }
    : {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: `progress-${round}` }] },
      };
}

/** Renders synthetic output and appends transcript records to a caller-owned fleet.
 * Returns verified byte/activity totals and removes listeners; the caller still owns disposal.
 */
export async function exerciseFleet(fleet: Fleet, rounds: number) {
  const counters = new Map(
    fleet.sessions.map((session) => [
      session.elwoodSessionId,
      { inputBytes: 0, observedBytes: 0, transcripts: 0 },
    ]),
  );
  const unsubs = fleet.sessions.flatMap((session) => {
    const counts = counters.get(session.elwoodSessionId)!;
    return [
      session.on("terminal:data", ({ elwoodSessionId, data }) => {
        assert.equal(elwoodSessionId, session.elwoodSessionId);
        counts.observedBytes += Buffer.byteLength(data);
      }),
      session.on("activity", (event) => {
        assert.equal(event.elwoodSessionId, session.elwoodSessionId);
        if (
          event.source === "transcript" &&
          (event.kind === "assistant_progress" || event.kind === "assistant_message")
        )
          counts.transcripts++;
      }),
    ];
  });
  const body = Array.from(
    { length: 32 },
    (_, row) => `  ${row}: ${"synthetic output ".repeat(6)}`,
  ).join("\r\n");
  try {
    for (let round = 0; round < rounds; round++) {
      for (const [index, session] of fleet.sessions.entries()) {
        const codex = index % 2 !== 0;
        const working = codex
          ? "• Working (2s • esc to interrupt)"
          : "✻ Working… (esc to interrupt)";
        const data = `\x1b]0;⠋ fleet\x07\x1b[2J\x1b[H${body}\r\n${working}\r\nROUND_${round}_${index}`;
        counters.get(session.elwoodSessionId)!.inputBytes += Buffer.byteLength(data);
        fleet.pty(session).emitData(data);
        if (round % transcriptEveryRounds === 0) {
          appendFileSync(
            join(session.cwd, "transcript.jsonl"),
            `${JSON.stringify(progress(round, codex))}\n`,
          );
        }
      }
      await Promise.all(fleet.sessions.map((session) => session.terminal.settled()));
      for (const [index, session] of fleet.sessions.entries()) {
        assert.ok(session.terminal.snapshot().text.includes(`ROUND_${round}_${index}`));
      }
    }
    // Grow normal-buffer history separately: full-screen repaints never exercise scrollback.
    const scroll = `${"history line\r\n".repeat(1_200)}HISTORY_END`;
    for (const session of fleet.sessions) {
      counters.get(session.elwoodSessionId)!.inputBytes += Buffer.byteLength(scroll);
      fleet.pty(session).emitData(scroll);
    }
    await Promise.all(fleet.sessions.map((session) => session.terminal.settled()));
    for (const session of fleet.sessions)
      assert.ok(session.terminal.snapshot().text.includes("HISTORY_END"));
    await Promise.all(
      fleet.sessions.map((session, index) =>
        fleet.pty(session).dispatchHook(
          session.elwoodSessionId,
          {
            hook_event_name: "Stop",
            session_id: `fleet-${index}`,
            cwd: session.cwd,
            transcript_path: join(session.cwd, "transcript.jsonl"),
            turn_id: `turn-${index}`,
            last_assistant_message: "",
            stop_hook_active: false,
          },
          join(fleet.root, "state"),
        ),
      ),
    );
    const totals = { inputBytes: 0, observedBytes: 0, transcripts: 0 };
    for (const [id, counts] of counters) {
      assert.equal(
        counts.transcripts,
        Math.ceil(rounds / transcriptEveryRounds),
        `Transcript count mismatch for ${id}`,
      );
      assert.equal(
        counts.observedBytes,
        counts.inputBytes,
        `Terminal byte count mismatch for ${id}`,
      );
      totals.inputBytes += counts.inputBytes;
      totals.observedBytes += counts.observedBytes;
      totals.transcripts += counts.transcripts;
    }
    return totals;
  } finally {
    for (const off of unsubs) off();
  }
}
