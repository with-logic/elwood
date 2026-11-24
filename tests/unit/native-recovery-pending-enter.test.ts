/** Native evidence during a pending first Enter revokes later recovery (C-API-31). */
import { afterEach, expect, test, vi } from "vitest";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import type { ClaudeEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { PasteRecoveryRevocation } from "../../src/runtime/session/paste-recovery.ts";

afterEach(() => vi.useRealTimers());

test("C-API-31 native submission during pending Enter permanently revokes recovery", async () => {
  vi.useFakeTimers();
  const events = new TypedEmitter<ClaudeEventMap>();
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
    events.emit("hook", {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude",
      cwd: "/project",
      prompt: "",
    });
    expect(recovery.captureRevocationGuard().revoked()).toBe(false);
    dispatched.resolve();
    await sent;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(writes).toEqual(["\u001b[200~draft\u001b[201~", "\r"]);
  } finally {
    closing.abort();
    dispatched.resolve();
  }
});
