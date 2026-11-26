/** A Claude prompt ID can name more than one submission (PRD §5.4, C-API-62, C-API-63). */
import { expect, test } from "vitest";
import { ClaudeUserPrompts } from "../../src/claude/transcript/user-prompts.ts";

const path = "/transcript.jsonl";
const record = (promptId: string, text: string) => ({
  type: "user",
  promptId,
  message: { content: text },
});

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
  prompts.observeForwardRecord(path, "running", record("running", "Write an essay."));
  expect(prompts.observeHook({ path, turnId: "running", hasText: false }, true)).toBe(false);
  expect(events).toEqual([]);
  // A textless submission waiting for its record keeps it when queued input reuses its ID.
  prompts.observeHook({ path, turnId: "textless", hasText: false }, true);
  expect(hook("textless", "Coordinator note.")).toBe(true);
  prompts.observeForwardRecord(path, "textless", record("textless", "Describe this image."));
  expect(events).toMatchObject([{ turnId: "textless", summary: { text: "Describe this image." } }]);
});

test("C-API-63 only a recent transcript recovery suppresses a nonblank hook", () => {
  const events: unknown[] = [];
  const prompts = new ClaudeUserPrompts((event) => events.push(event));
  for (let index = 0; index <= 64; index++) {
    prompts.observeHook({ path, turnId: `r-${index}`, hasText: false }, true);
    prompts.observeForwardRecord(path, `r-${index}`, record(`r-${index}`, `text ${index}`));
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
  const delivered = (item: unknown) => prompts.observeForwardRecord(path, undefined, item);
  expect(hook("running", "Write an essay.")).toBe(true);
  expect(hook("running", "Note A.")).toBe(true);
  expect(hook("running", "Note B.")).toBe(true);
  // An interrupt cancelled B's screening, so Claude screens it again as the drained turn's prompt.
  expect(hook("drained", "Note B.")).toBe(false);
  // A ran as its own turn without a second hook; its queued record ends the pending entry.
  delivered({ type: "queue-operation", operation: "enqueue", content: "Note A." });
  delivered({ type: "queue-operation", operation: "remove", content: 7 });
  delivered({ ...record("typed", "Note A."), promptSource: "typed" });
  delivered({ ...record("queued", "Note A."), promptSource: "queued", message: { content: [] } });
  delivered("not a record");
  prompts.observeForwardRecord(path, "a", { ...record("a", "Note A."), promptSource: "queued" });
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
