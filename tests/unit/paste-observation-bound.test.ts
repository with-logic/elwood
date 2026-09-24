/** Dialog observation cannot keep detached recovery alive forever (C-API-31). */
import { expect, test, vi } from "vitest";
import { writeQueuedInput } from "../../src/core/input/index.ts";

test("C-API-31 a dialog consumes observations without sending a recovery Enter", async () => {
  vi.useFakeTimers();
  const writes: string[] = [];
  let blocked = false;
  try {
    const sent = writeQueuedInput(
      { sendInput: (data) => void writes.push(String(data)) },
      "draft",
      "pasted_input",
      { snapshot: () => "draft", staged: () => true, blocked: () => blocked },
    );
    await vi.advanceTimersByTimeAsync(150);
    await sent;
    blocked = true;
    await vi.advanceTimersByTimeAsync(5_000);
    blocked = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes.filter((data) => data === "\r")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
