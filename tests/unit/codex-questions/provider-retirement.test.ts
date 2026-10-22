/** Changed metadata cannot release retired Codex native identities (PRD §4). */
import { expect, test } from "vitest";
import { QuestionTransaction } from "../../../src/core/questions/transaction.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { reply } from "./acceptance-helpers.ts";
import { harness } from "./adapter-helpers.ts";
import { captured, frame } from "./helpers.ts";

const color = "ELWOOD_ASYNC_COLOR: Which color?";
const note = "ELWOOD_ASYNC_NOTE: What note?";
const native = (id: string, prompt = color, second = note) => ({
  payload: {
    type: "AgentMessage",
    id,
    delivery: "async",
    questions: [{ title: prompt, options: ["Amber", "Blue"] }, { title: second }],
  },
});

test("retired Codex identity keeps native acknowledgement correlation across changed metadata", async () => {
  const h = harness();
  const writes: string[] = [];
  const terminal = createHeadlessTerminal({ cols: 140, rows: 45 }, (input) =>
    writes.push(String(input)),
  );
  const closing = new AbortController();
  try {
    h.observe(native("call"));
    h.adapter.render(captured("async-badge.txt"));
    const original = h.registry.list()[0]!;
    const sibling = h.registry.list()[1]!;
    expect(original).toBeDefined();
    expect(sibling).toBeDefined();
    const key = h.registry.keyFor(original.id)!;
    h.registry.retireUnconfirmed(original.id);
    const changed = `Changed ${color}`;
    expect(h.observe(native("call", changed, `Changed ${note}`))).toBe(true);
    h.adapter.render(frame(captured("async-editor-first.txt").text.replaceAll(color, changed)));
    h.adapter.render(captured("async-badge.txt"));
    expect(h.registry.find(key)).toBe(original);
    expect(h.registry.get(original.id)).toBeUndefined();
    expect(h.registry.list().map((request) => request.questions[0]?.prompt)).toEqual([
      `Changed ${note}`,
    ]);
    expect(h.registry.get(sibling.id)).toBeUndefined();
    expect(h.registry.hasPending()).toBe(true);
    expect(h.adapter.blocksInput()).toBe(true);
    const transaction = new QuestionTransaction(
      h.registry,
      terminal,
      () => new AbortController().signal,
      closing.signal,
    );
    await expect(transaction.run(h.adapter, original.id, [])).rejects.toMatchObject({
      code: "question_not_found",
    });
    expect(writes).toEqual([]);
    h.adapter.observe(reply(key, "Amber"));
    expect(h.registry.find(key)).toBeUndefined();
    expect(
      h.events.filter((event) => event.request.id === original.id).map((event) => event.phase),
    ).toEqual(["raised", "closed"]);
    h.observe({ payload: { type: "turn_complete" } });
    expect(h.registry.hasPending()).toBe(false);
    h.observe(native("next", changed));
    h.adapter.render(captured("async-badge.txt"));
    expect(h.registry.list()).toHaveLength(2);
    expect(h.registry.list()[0]?.questions[0]?.prompt).toBe(changed);
  } finally {
    closing.abort();
    h.registry.shutdown();
    terminal.dispose();
  }
});
