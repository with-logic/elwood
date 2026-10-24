/** Fixed redraw, scrolling, snapshot and transcript traffic for PRD §9.2 profiling. */
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Executable benchmark correctness checks.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { createFleet } from "./fleet-runtime.ts";

type Fleet = Awaited<ReturnType<typeof createFleet>>;

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

export async function exerciseFleet(fleet: Fleet, rounds: number) {
  let inputBytes = 0;
  let observedBytes = 0;
  let transcripts = 0;
  const unsubs = fleet.sessions.flatMap((session) => [
    session.on("terminal:data", ({ data }) => {
      observedBytes += Buffer.byteLength(data);
    }),
    session.on("activity", (event) => {
      if (
        event.source === "transcript" &&
        (event.kind === "assistant_progress" || event.kind === "assistant_message")
      )
        transcripts++;
    }),
  ]);
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
        inputBytes += Buffer.byteLength(data);
        fleet.pty(session).emitData(data);
        if (round % 8 === 0) {
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
      inputBytes += Buffer.byteLength(scroll);
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
    assert.equal(transcripts, fleet.sessions.length * Math.ceil(rounds / 8));
    assert.equal(observedBytes, inputBytes);
    return { inputBytes, observedBytes, transcripts };
  } finally {
    for (const off of unsubs) off();
  }
}
