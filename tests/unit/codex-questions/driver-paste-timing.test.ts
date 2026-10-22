/** Completed native text still needs paste settlement before final dispatch (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { answerQueued } from "../../../src/codex/questions/driver.ts";
import { pasteSettleDelayMs } from "../../../src/core/input/index.ts";
import type { QuestionIo } from "../../../src/core/questions/adapter.ts";
import { editorFrame } from "./editor-fixtures.ts";
import { captured, definitions, frame, scriptedIo } from "./helpers.ts";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test("an early pasted frame cannot submit until settlement, then notifies immediately before Enter", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const initial = editorFrame(captured("async-after-first.txt"), {
    editorLine: "  Type your answer",
    cursorLineBefore: "  ",
    dimmed: true,
  });
  const text = "ELWOOD_TIMED_NOTE";
  const typed = editorFrame(frame(initial.text.replace("  Type your answer", `  ${text}`)), {
    editorLine: `  ${text}`,
    cursorLineBefore: `  ${text}`,
    dimmed: false,
  });
  const paste = `\x1b[200~${text}\x1b[201~`;
  const scripted = scriptedIo(initial, [{ input: paste, next: typed }, { input: "\r" }]);
  const rendered = Promise.withResolvers<void>();
  const order: string[] = [];
  let visible = initial;
  const frameDelayMs = 20;
  const io: QuestionIo = {
    ...scripted.io,
    frame: () => visible,
    wait: async (matches) => {
      await rendered.promise;
      return scripted.io.wait(matches);
    },
    write: async (input, matches, onDispatch) => {
      await scripted.io.write(input, matches, () => {
        onDispatch?.();
        order.push(input === paste ? "paste" : "enter");
      });
      if (input === paste)
        setTimeout(() => {
          visible = typed;
          order.push("render");
          rendered.resolve();
        }, frameDelayMs);
    },
  };
  const submitting = vi.fn(() => {
    expect(Date.now()).toBeGreaterThanOrEqual(pasteSettleDelayMs);
    expect(scripted.writes).toEqual([paste]);
    order.push("submitting");
  });
  const pending = answerQueued(
    [definitions("async-records.json")[1]!],
    { optionIndexes: [], text },
    0,
    io,
    submitting,
  ).then(
    () => ({ kind: "resolved" as const }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(order).toEqual(["paste"]);
  expect(io.frame()).toBe(initial);
  await vi.advanceTimersByTimeAsync(frameDelayMs);
  expect(io.frame()).toBe(typed);
  expect(order).toEqual(["paste", "render"]);
  expect(submitting).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(pasteSettleDelayMs - frameDelayMs - 1);
  expect(scripted.writes).toEqual([paste]);
  expect(submitting).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(frameDelayMs + 1);
  expect(await pending).toEqual({ kind: "resolved" });
  expect(scripted.writes).toEqual([paste, "\r"]);
  expect(submitting).toHaveBeenCalledOnce();
  expect(order).toEqual(["paste", "render", "submitting", "enter"]);
});
