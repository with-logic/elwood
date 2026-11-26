/** A Claude prompt ID can name more than one submission (PRD §5.4, C-API-62, C-API-63). */
import { expect, test } from "vitest";
import { ClaudeTranscriptWatcher } from "../../src/claude/transcript/index.ts";
import { ClaudeUserPrompts } from "../../src/claude/transcript/user-prompts.ts";
import { appendRecords, nativeUser, tmpFile, writeRecords } from "./claude-transcript-helpers.ts";

const path = "/transcript.jsonl";

test("C-API-62 a nonblank hook that reuses a shown prompt ID keeps its message", () => {
  const events: unknown[] = [];
  const prompts = new ClaudeUserPrompts((event) => events.push(event));
  const hook = (turnId: string, prompt: string) =>
    prompts.observeHook({ path, turnId, hasText: true, prompt }, true);
  expect(hook("running", "Write an essay.")).toBe(true);
  // Claude gives a message queued during a running turn that turn's ID, even when text repeats.
  expect(hook("running", "Coordinator note: end with MARK.")).toBe(true);
  expect(hook("running", "Coordinator note: end with MARK.")).toBe(true);
  // The hook already showed this ID, so its transcript copy is not shown again.
  prompts.observeForwardRecord(path, "running", nativeUser("running", "Write an essay."), true);
  expect(prompts.observeHook({ path, turnId: "running", hasText: false }, true)).toBe(false);
  expect(events).toEqual([]);
  // A textless submission waiting for its record keeps it when queued input reuses its ID.
  prompts.observeHook({ path, turnId: "textless", hasText: false }, true);
  expect(hook("textless", "Coordinator note.")).toBe(true);
  prompts.observeForwardRecord(
    path,
    "textless",
    nativeUser("textless", "Describe this image."),
    true,
  );
  expect(events).toMatchObject([{ turnId: "textless", summary: { text: "Describe this image." } }]);
});

test("C-API-63 only a recent transcript recovery suppresses a nonblank hook", () => {
  const events: unknown[] = [];
  const prompts = new ClaudeUserPrompts((event) => events.push(event));
  for (let index = 0; index <= 64; index++) {
    prompts.observeHook({ path, turnId: `r-${index}`, hasText: false }, true);
    prompts.observeForwardRecord(
      path,
      `r-${index}`,
      nativeUser(`r-${index}`, `text ${index}`),
      true,
    );
  }
  expect(events).toHaveLength(65);
  const hook = (turnId: string, prompt: string) =>
    prompts.observeHook({ path, turnId, hasText: true, prompt }, true);
  expect(hook("r-64", "text 64")).toBe(false);
  expect(hook("r-64", "other text")).toBe(true);
  // Recovered prompts beyond the most recent 64 no longer suppress their hook.
  expect(hook("r-0", "text 0")).toBe(true);
});

test("C-API-62 a queued message that Claude screens again under a new ID is shown once", () => {
  const prompts = new ClaudeUserPrompts(() => undefined);
  const hook = (turnId: string, prompt: string) =>
    prompts.observeHook({ path, turnId, hasText: true, prompt }, true);
  const delivered = (item: unknown) => prompts.observeForwardRecord(path, undefined, item, true);
  expect(hook("running", "Write an essay.")).toBe(true);
  expect(hook("running", "Note A.")).toBe(true);
  expect(hook("running", "Note B.")).toBe(true);
  // An interrupt cancelled B's screening, so Claude screens it again as the drained turn's prompt.
  expect(hook("drained", "Note B.")).toBe(false);
  // A ran as its own turn without a second hook; its queued record ends the pending entry.
  delivered({ type: "queue-operation", operation: "enqueue", content: "Note A." });
  delivered({ type: "queue-operation", operation: "remove", content: 7 });
  delivered({ ...nativeUser("typed", "Note A."), promptSource: "typed" });
  delivered({
    ...nativeUser("queued", "Note A."),
    promptSource: "queued",
    message: { content: [] },
  });
  delivered("not a record");
  prompts.observeForwardRecord(
    path,
    "a",
    { ...nativeUser("a", "Note A."), promptSource: "queued" },
    true,
  );
  expect(hook("next", "Note A.")).toBe(true);
  // A message taken inside the running turn is removed from Claude's queue.
  expect(hook("next", "Note C.")).toBe(true);
  delivered({ type: "queue-operation", operation: "remove", content: "Note C." });
  expect(hook("later", "Note C.")).toBe(true);
  // Without transcript correlation, delivery cannot be seen, so nothing stays pending.
  expect(hook("later", "Note D.")).toBe(true);
  prompts.clearUnpaired();
  expect(hook("fresh", "Note D.")).toBe(true);
  // Only the most recent 64 queued messages stay pending.
  for (let index = 0; index <= 64; index++) hook("fresh", `Queued ${index}.`);
  expect(hook("rescreen-0", "Queued 0.")).toBe(true);
  expect(hook("rescreen-64", "Queued 64.")).toBe(false);
});

test("C-API-62 without transcript correlation a repeated text is shown, never suppressed", () => {
  const watcher = new ClaudeTranscriptWatcher("s", () => undefined);
  const hook = (at: string | undefined, turnId: string, prompt: string) =>
    watcher.observeUserPromptHook({ path: at, turnId, hasText: true, prompt });
  expect(hook(undefined, "running", "Write an essay.")).toBe(true);
  expect(hook(undefined, "running", "Note.")).toBe(true);
  expect(hook(undefined, "later", "Note.")).toBe(true);
  watcher.finish();
  expect(hook(path, "done", "Write an essay.")).toBe(true);
  expect(hook(path, "done", "Note.")).toBe(true);
  expect(hook(path, "next", "Note.")).toBe(true);
});

test("C-API-62 a transcript rewind leaves no queued message pending", () => {
  const live = tmpFile();
  const watcher = new ClaudeTranscriptWatcher("s", () => undefined);
  const hook = (turnId: string, prompt: string) =>
    watcher.observeUserPromptHook({ path: live, turnId, hasText: true, prompt });
  writeRecords(live);
  try {
    watcher.observe(live);
    appendRecords(
      live,
      [],
      nativeUser("old-1", "x".repeat(200)),
      nativeUser("old-2", "y".repeat(200)),
    );
    watcher.scan();
    expect(hook("running", "Write an essay.")).toBe(true);
    expect(hook("running", "Note B.")).toBe(true);
    expect(hook("rescreen", "Note B.")).toBe(false);
    expect(hook("running", "Note C.")).toBe(true);
    // A shorter rewrite replays old records, which cannot tell old delivery from new.
    writeRecords(live, { ...nativeUser("old-3", "Note B."), promptSource: "queued" });
    watcher.scan();
    expect(hook("after-rewind", "Note C.")).toBe(true);
  } finally {
    watcher.stop();
  }
});

test("C-API-62 C-HOOK-24 a hidden repeat of a recovered prompt still queues, and shows once re-screened", () => {
  const prompts = new ClaudeUserPrompts(() => undefined);
  const hook = (turnId: string, prompt: string) =>
    prompts.observeHook({ path, turnId, hasText: true, prompt }, true);
  prompts.observeHook({ path, turnId: "recovered", hasText: false }, true);
  prompts.observeForwardRecord(path, "recovered", nativeUser("recovered", "Repeat me."), true);
  // A repeat under the recovered ID reads as that submission, but Claude may run it as queued.
  expect(hook("recovered", "Repeat me.")).toBe(false);
  expect(prompts.queuedPrompts.hasRunnableIn({ from: 0, to: 1 })).toBe(true);
  // Screened again under a new ID after an interrupt, it shows, since its first hook was hidden.
  expect(hook("rescreen", "Repeat me.")).toBe(true);
  expect(prompts.queuedPrompts.hasRunnableIn({ from: 0, to: 1 })).toBe(false);
});

test("C-HOOK-24 only live dequeue records of the main transcript count as a started queued turn", () => {
  const [live, agent] = [tmpFile(), tmpFile()];
  const watcher = new ClaudeTranscriptWatcher("s", () => undefined);
  const earlier = Date.now() - 10_000;
  const dequeue = (at = Date.now()) => ({
    type: "queue-operation",
    operation: "dequeue",
    timestamp: new Date(at).toISOString(),
  });
  const queued = () => watcher.queuedPrompts();
  const dequeuedAfterEarlier = () => queued()?.dequeuedSince(earlier + 1);
  const anyPending = () => queued()?.hasRunnableIn({ from: 0, to: Number.MAX_SAFE_INTEGER });
  writeRecords(live);
  writeRecords(agent);
  try {
    watcher.observe(live);
    watcher.observe(agent, false, undefined, true);
    appendRecords(live, [], nativeUser("old-1", "x".repeat(200)), dequeue(earlier));
    appendRecords(agent, [], dequeue());
    watcher.scan();
    expect(queued()?.dequeuedSince(earlier)).toBe(true); // read with nothing pending
    expect(dequeuedAfterEarlier()).toBe(false); // the subagent's never counts
    watcher.observeUserPromptHook({
      path: live,
      turnId: "running",
      hasText: true,
      prompt: "Essay.",
    });
    watcher.observeUserPromptHook({
      path: live,
      turnId: "running",
      hasText: true,
      prompt: "Note.",
    });
    expect(anyPending()).toBe(true);
    // A shorter rewrite replays old records: an old dequeue starts no turn now.
    writeRecords(live, dequeue());
    watcher.scan();
    expect(dequeuedAfterEarlier()).toBe(false);
    expect(anyPending()).toBe(false);
    watcher.finish();
    expect(queued()).toBeUndefined();
  } finally {
    watcher.stop();
  }
});
