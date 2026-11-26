/** A fake-timer harness for the held Claude `Stop` (PRD §6.5, C-HOOK-24). */
import { vi } from "vitest";
import {
  holdForQueuedTurn,
  type QueuedTurnEnd,
  type QueuedTurnEvidence,
} from "../../src/claude/session/queued-turn.ts";
import { textDigest } from "../../src/claude/transcript/prompt-keys.ts";
import { ClaudeQueuedPrompts } from "../../src/claude/transcript/queued-prompts.ts";
import { nativeUser } from "./claude-transcript-helpers.ts";

/** C-HOOK-24's window and its unread-transcript fallback, stated independently of the implementation. */
export const boundMs = 2_000;
export const unreadLimitMs = 10_000;
export const transcriptPath = "/claude/session.jsonl";
type Watcher = QueuedTurnEvidence["transcriptWatcher"];
export const evidence = (
  queued?: ClaudeQueuedPrompts,
  scanPath: Watcher["scanPath"] = () => true,
) => ({
  transcriptWatcher: { scanPath, queuedPrompts: () => queued },
  transcriptPath,
});
/** A `dequeue` record Claude stamped `offsetMs` from now. */
export const dequeue = (offsetMs = 100) => ({
  type: "queue-operation",
  operation: "dequeue",
  timestamp: new Date(Date.now() + offsetMs).toISOString(),
});
export const queuedRecord = (text: string) => ({
  ...nativeUser("queued", text),
  promptSource: "queued",
});

export function harness(ownsTurnEnd = true) {
  vi.useFakeTimers();
  const queued = new ClaudeQueuedPrompts();
  queued.queued(textDigest("note"));
  const records: unknown[] = [];
  const log: string[] = [];
  const closing = new AbortController();
  const state = { screening: false, reachedEnd: true };
  const end: QueuedTurnEnd = {
    ownsTurnEnd: () => ownsTurnEnd,
    screening: () => state.screening,
    endTurn: (unconfirmed) => void log.push(unconfirmed ? "warn and end" : "end"),
    release: () => void log.push("release"),
    closing: closing.signal,
    observation: { run: (_phase, operation) => operation() },
  };
  const scanPath = (path: string | undefined, chunks: number) => {
    log.push(`read ${path} ${chunks}`);
    for (const record of records.splice(0)) queued.observeRecord(record, true);
    return state.reachedEnd;
  };
  const hold = () => holdForQueuedTurn(evidence(queued, scanPath), end);
  const step = (ms = 50) => vi.advanceTimersByTime(ms);
  const ends = () => log.filter((entry) => entry.endsWith("end"));
  return { queued, records, log, closing, end, state, hold, step, ends, waiting: vi.getTimerCount };
}
