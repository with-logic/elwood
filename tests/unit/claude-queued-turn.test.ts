/** A Claude `Stop` with queued messages waits for their turn, bounded (PRD §6.5, C-HOOK-24). */
import { afterEach, expect, test, vi } from "vitest";
import {
  holdForQueuedTurn,
  type QueuedTurnEnd,
  queuedTurnStartLimitMs,
} from "../../src/claude/session/queued-turn.ts";
import { textDigest } from "../../src/claude/transcript/prompt-keys.ts";
import { ClaudeQueuedPrompts } from "../../src/claude/transcript/queued-prompts.ts";
import { assertStopInput, withStopInput } from "../../src/core/stop-input.ts";
import { nativeUser } from "./claude-transcript-helpers.ts";

afterEach(() => void vi.useRealTimers());
const dequeue = { type: "queue-operation", operation: "dequeue" };
const queuedRecord = (text: string) => ({ ...nativeUser("queued", text), promptSource: "queued" });
const pastBound = () => vi.advanceTimersByTime(queuedTurnStartLimitMs + 100);

function harness(ownsTurnEnd = true) {
  vi.useFakeTimers();
  const queued = new ClaudeQueuedPrompts();
  queued.queued(textDigest("note"));
  const records: unknown[] = [];
  const log: string[] = [];
  const closing = new AbortController();
  const end: QueuedTurnEnd = {
    ownsTurnEnd: () => ownsTurnEnd,
    endUnconfirmedTurn: () => void log.push("end"),
    closing: closing.signal,
    observation: { run: (_phase, operation) => operation() },
  };
  const scan = () => {
    log.push("scan");
    for (const record of records.splice(0)) queued.observeRecord(record, true);
  };
  const hold = () => holdForQueuedTurn({ scan, queuedPrompts: () => queued }, end);
  const step = () => vi.advanceTimersByTime(50);
  const ends = () => log.filter((entry) => entry === "end").length;
  return { queued, records, log, closing, end, hold, step, ends, waiting: vi.getTimerCount };
}

test("C-HOOK-24 a Stop holds only for messages Claude may run that were queued since the last Stop", () => {
  const { end, log } = harness();
  const empty = new ClaudeQueuedPrompts();
  expect(holdForQueuedTurn({ scan: () => {}, queuedPrompts: () => empty }, end)).toBe(false);
  expect(holdForQueuedTurn({ scan: () => {}, queuedPrompts: () => undefined }, end)).toBe(false);
  // The caller's handler blocked this message, which Claude never runs.
  const blocked = new ClaudeQueuedPrompts();
  blocked.queued(textDigest("other"));
  blocked.queued(textDigest("note"));
  blocked.block(0, "note"); // not the message queued at that position
  blocked.block(1, "note");
  blocked.block(undefined, "other"); // the hook queued nothing
  expect(blocked.hasPendingIn({ from: 0, to: 2 })).toBe(true);
  blocked.claim(textDigest("other"));
  expect(holdForQueuedTurn({ scan: () => {}, queuedPrompts: () => blocked }, end)).toBe(false);
  expect(blocked.claim(textDigest("note"))).toBe(false); // forgotten at the Stop
  // An earlier `Stop` owns what was queued before it.
  const earlier = new ClaudeQueuedPrompts();
  earlier.queued(textDigest("note"));
  earlier.stopWindow();
  expect(holdForQueuedTurn({ scan: () => {}, queuedPrompts: () => earlier }, end)).toBe(false);
  expect(log).toEqual([]);
});

test("C-HOOK-24 the queued turn's dequeue and records end the wait without an end", () => {
  const { hold, records, log, step, waiting, queued } = harness();
  queued.observeRecord(dequeue, true); // an earlier turn's dequeue is not this Stop's evidence
  queued.observeRecord(dequeue, false); // a replayed or subagent dequeue is never counted
  expect(queued.dequeueCount).toBe(1);
  expect(hold()).toBe(true);
  step();
  records.push(dequeue);
  step();
  // Claude started the turn; its `queued` record, which names its prompt ID, is still unread.
  expect(waiting()).toBe(1);
  records.push(queuedRecord("note"));
  step();
  expect(waiting()).toBe(0);
  expect(log).toEqual(["scan", "scan", "scan"]);
});

test("C-HOOK-24 the bound forgets messages queued before the Stop and ends only an unstarted turn", () => {
  const started = harness();
  started.queued.queued(textDigest("unmatched"));
  expect(started.hold()).toBe(true);
  started.records.push(dequeue, queuedRecord("note"));
  started.step();
  started.queued.queued(textDigest("later")); // queued during the next turn, after this Stop
  pastBound();
  expect(started.waiting()).toBe(0);
  expect(started.ends()).toBe(0); // the queued turn's own Stop ends it
  expect(started.queued.claim(textDigest("unmatched"))).toBe(false);
  expect(started.queued.claim(textDigest("later"))).toBe(true);

  const unstarted = harness();
  unstarted.queued.observeRecord(dequeue, true); // a dequeue before this Stop starts nothing
  expect(unstarted.hold()).toBe(true);
  vi.advanceTimersByTime(queuedTurnStartLimitMs - 50);
  expect(unstarted.ends()).toBe(0);
  pastBound();
  expect(unstarted.ends()).toBe(1);
  expect(unstarted.queued.isEmpty).toBe(true);
});

test("C-HOOK-11 C-HOOK-24 a superseded or closing hold ends no turn", () => {
  const superseded = harness(false);
  expect(superseded.hold()).toBe(true);
  pastBound();
  expect(superseded.ends()).toBe(0);
  expect(superseded.queued.isEmpty).toBe(true);
  const closed = harness();
  expect(closed.hold()).toBe(true);
  closed.closing.abort();
  pastBound();
  expect(closed.log).toEqual([]);
});

test("C-HOOK-04 C-HOOK-24 hold polls do not inherit the finished Stop's input context", async () => {
  const session = { elwoodSessionId: "session" };
  const queued = new ClaudeQueuedPrompts();
  queued.queued(textDigest("note"));
  const { end, closing } = harness();
  vi.useRealTimers();
  let accepted: boolean | undefined;
  const scan = () => {
    try {
      assertStopInput(session);
      accepted = true;
    } catch {
      accepted = false;
    }
    closing.abort();
  };
  await withStopInput({ hookName: "Stop", session }, () =>
    Promise.resolve(holdForQueuedTurn({ scan, queuedPrompts: () => queued }, end)),
  );
  await vi.waitFor(() => expect(accepted).toBe(true));
});
