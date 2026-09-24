/** Native evidence during a pending first Enter revokes later recovery (C-API-31). */
import { afterEach, expect, test, vi } from "vitest";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import type { ElwoodCommonEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { PasteRecoveryRevocation } from "../../src/runtime/session/paste-recovery.ts";

afterEach(() => vi.useRealTimers());

test.each([
  "hook",
  "working",
])("C-API-31 %s during pending Enter revokes recovery", async (evidence) => {
  vi.useFakeTimers();
  const events = new TypedEmitter<ElwoodCommonEventMap>();
  const closing = new AbortController();
  const recovery = new PasteRecoveryRevocation(events, closing.signal);
  const dispatched = Promise.withResolvers<void>();
  const writes: string[] = [];
  const input = {
    sendInput(value: string | Uint8Array) {
      writes.push(String(value));
      if (value === "\r") return dispatched.promise;
      return undefined;
    },
  };
  try {
    const sent = writeQueuedInput(input, "draft", "pasted_input", {
      snapshot: () => "draft",
      staged: () => true,
      captureRecovery: () => recovery.captureRevocationGuard(),
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(writes).toEqual(["\u001b[200~draft\u001b[201~", "\r"]);
    if (evidence === "working") recovery.observeWorking(true);
    else
      events.emit("activity", {
        agent: "claude",
        elwoodSessionId: "s",
        source: "hook",
        kind: "user_message",
        label: "user",
      });
    const active = recovery.captureRevocationGuard();
    recovery.observeWorking(false);
    expect(active.revoked()).toBe(evidence === "working");
    dispatched.resolve();
    await sent;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(writes).toEqual(["\u001b[200~draft\u001b[201~", "\r"]);
  } finally {
    closing.abort();
    dispatched.resolve();
  }
});
