/** Physical submission evidence follows the submitting Enter (PRD §5.3, C-ATTN-02). */
import { afterEach, expect, test, vi } from "vitest";
import { writeQueuedInput } from "../../src/core/input/index.ts";

afterEach(() => vi.useRealTimers());

test("C-ATTN-02 physical submission follows paste and the awaited Enter write", async () => {
  vi.useFakeTimers();
  const order: string[] = [];
  let acceptEnter!: () => void;
  const terminal = {
    sendInput: (data: string | Uint8Array) => {
      order.push(String(data));
      if (data === "\r")
        return new Promise<void>((resolve) => {
          acceptEnter = resolve;
        });
      return undefined;
    },
  };
  const submitted = writeQueuedInput(
    terminal,
    "hello",
    "pasted_input",
    undefined,
    undefined,
    undefined,
    () => order.push("submitted"),
  );
  expect(order).toEqual(["\u001b[200~hello\u001b[201~"]);
  await vi.advanceTimersByTimeAsync(150);
  expect(order).toEqual(["\u001b[200~hello\u001b[201~", "\r"]);
  acceptEnter();
  await submitted;
  expect(order).toEqual(["\u001b[200~hello\u001b[201~", "\r", "submitted"]);
});
