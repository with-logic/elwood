/** A Claude `Stop` with queued messages waits for their turn, bounded (PRD §6.5, C-HOOK-24). */
import { afterEach, expect, test, vi } from "vitest";
import { holdForQueuedTurn, type QueuedTurnEnd } from "../../src/claude/session/queued-turn.ts";
import { textDigest } from "../../src/claude/transcript/prompt-keys.ts";
import { ClaudeQueuedPrompts } from "../../src/claude/transcript/queued-prompts.ts";
import { assertStopInput, withStopInput } from "../../src/core/stop-input.ts";
import { nativeUser } from "./claude-transcript-helpers.ts";

afterEach(() => void vi.useRealTimers());
/** C-HOOK-24's bound, stated independently of the implementation. */
const boundMs = 2_000;
/** A `dequeue` record Claude stamped `offsetMs` from now. */
const dequeue = (offsetMs = 100) => ({
  type: "queue-operation",
  operation: "dequeue",
  timestamp: new Date(Date.now() + offsetMs).toISOString(),
});
const queuedRecord = (text: string) => ({ ...nativeUser("queued", text), promptSource: "queued" });

function harness(ownsTurnEnd = true) {
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
  const scan = (chunks?: number) => {
    log.push(`scan ${chunks}`);
    for (const record of records.splice(0)) queued.observeRecord(record, true);
    return state.reachedEnd;
  };
  const hold = () => holdForQueuedTurn({ scan, queuedPrompts: () => queued }, end);
  const step = (ms = 50) => vi.advanceTimersByTime(ms);
  const ends = () => log.filter((entry) => entry.endsWith("end"));
  return { queued, records, log, closing, end, state, hold, step, ends, waiting: vi.getTimerCount };
}

test("C-HOOK-24 a Stop holds only for messages Claude may run that were queued since the last Stop", () => {
  const { end, log } = harness();
  const scan = () => true;
  const empty = new ClaudeQueuedPrompts();
  expect(holdForQueuedTurn({ scan, queuedPrompts: () => empty }, end)).toBe(false);
  expect(holdForQueuedTurn({ scan, queuedPrompts: () => undefined }, end)).toBe(false);
  // The caller's handler blocked this message, which Claude never runs.
  const blocked = new ClaudeQueuedPrompts();
  blocked.queued(textDigest("other"));
  blocked.queued(textDigest("note"));
  blocked.block(0, "note"); // not the message queued at that position
  blocked.block(1, "note");
  blocked.block(undefined, "other"); // the hook queued nothing
  expect(blocked.hasPendingIn({ from: 0, to: 2 })).toBe(true);
  blocked.claim(textDigest("other"));
  expect(holdForQueuedTurn({ scan, queuedPrompts: () => blocked }, end)).toBe(false);
  expect(blocked.claim(textDigest("note"))).toBe(false); // forgotten at the Stop
  // An earlier `Stop` owns what was queued before it.
  const earlier = new ClaudeQueuedPrompts();
  earlier.queued(textDigest("note"));
  earlier.takeStopWindow();
  expect(holdForQueuedTurn({ scan, queuedPrompts: () => earlier }, end)).toBe(false);
  expect(log).toEqual([]);
});

test("C-HOOK-24 the queued turn's dequeue and records end the wait without an end", () => {
  const { hold, records, log, step, waiting, queued } = harness();
  queued.observeRecord(dequeue(100), false); // a replayed or subagent dequeue never counts
  expect(queued.dequeuedSince(Date.now())).toBe(false);
  expect(hold()).toBe(true);
  step();
  records.push(dequeue());
  step();
  // Claude started the turn; its `queued` record, which names its prompt ID, is still unread.
  expect(waiting()).toBe(1);
  records.push(queuedRecord("note"));
  step();
  expect(waiting()).toBe(0);
  // Each poll reads one chunk, so a backlog cannot block the event loop for long.
  expect(log).toEqual(["scan 1", "scan 1", "scan 1", "release"]);
});

test("C-HOOK-24 the 2-second bound forgets messages queued before the Stop and ends only an unstarted turn", () => {
  const started = harness();
  started.queued.queued(textDigest("unmatched"));
  expect(started.hold()).toBe(true);
  started.records.push(dequeue(), queuedRecord("note"));
  started.step();
  started.queued.queued(textDigest("later")); // queued during the next turn, after this Stop
  started.step(boundMs);
  expect(started.waiting()).toBe(0);
  expect(started.ends()).toEqual([]); // the queued turn's own Stop ends it
  expect(started.queued.claim(textDigest("unmatched"))).toBe(false);
  expect(started.queued.claim(textDigest("later"))).toBe(true);

  const unstarted = harness();
  expect(unstarted.hold()).toBe(true);
  // Read late behind a backlog, a dequeue stamped before the Stop started nothing.
  unstarted.records.push(dequeue(-5_000));
  unstarted.step(boundMs - 50);
  expect(unstarted.ends()).toEqual([]);
  unstarted.step();
  expect(unstarted.ends()).toEqual(["warn and end"]);
  expect(unstarted.queued.isEmpty).toBe(true);
  expect(unstarted.log.at(-1)).toBe("release");
});

test("C-HOOK-24 a dequeue counts by its stamp, with an allowance before the Stop", () => {
  const queued = new ClaudeQueuedPrompts();
  queued.observeRecord(dequeue(-900), true);
  expect(queued.dequeuedSince(Date.now() - 1_000)).toBe(true);
  expect(queued.dequeuedSince(Date.now())).toBe(false);
  // An unstamped record counts as read now, the latest Claude can have written it.
  queued.observeRecord({ type: "queue-operation", operation: "dequeue" }, true);
  expect(queued.dequeuedSince(Date.now())).toBe(true);
  const allowed = harness();
  expect(allowed.hold()).toBe(true);
  allowed.records.push(dequeue(-900), queuedRecord("note"));
  allowed.step();
  expect(allowed.log.at(-1)).toBe("release");
  expect(allowed.ends()).toEqual([]);
});

test("C-HOOK-24 the bound starts once no handler screens, and waits for the transcript's end", () => {
  const { hold, state, step, ends, log } = harness();
  state.screening = true;
  expect(hold()).toBe(true);
  step(5_000); // Claude runs the message only once the caller's handler allows it
  expect(ends()).toEqual([]);
  state.screening = false;
  step(boundMs - 50);
  expect(ends()).toEqual([]);
  state.reachedEnd = false; // the dequeue may be behind a backlog
  step(1_000);
  expect(ends()).toEqual([]);
  state.reachedEnd = true;
  step();
  expect(ends()).toEqual(["warn and end"]);
  expect(log.at(-1)).toBe("release");
});

test("C-HOOK-24 messages all blocked after the Stop end its turn at once without a warning", () => {
  const { hold, state, step, ends, queued } = harness();
  state.screening = true;
  expect(hold()).toBe(true);
  step();
  queued.block(0, "note");
  state.screening = false;
  step();
  expect(ends()).toEqual(["end"]);
});

test("C-HOOK-11 C-HOOK-24 a superseded or closing hold ends no turn", () => {
  const superseded = harness(false);
  expect(superseded.hold()).toBe(true);
  superseded.step(boundMs);
  expect(superseded.ends()).toEqual([]);
  expect(superseded.queued.isEmpty).toBe(true);
  const closed = harness();
  expect(closed.hold()).toBe(true);
  closed.closing.abort();
  closed.step(boundMs);
  expect(closed.log).toEqual(["release"]);
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
    return true;
  };
  await withStopInput({ hookName: "Stop", session }, () =>
    Promise.resolve(holdForQueuedTurn({ scan, queuedPrompts: () => queued }, end)),
  );
  await vi.waitFor(() => expect(accepted).toBe(true));
});
