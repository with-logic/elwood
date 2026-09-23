/** Unaccepted replay drafts remain owned through successor cleanup (PRD §5.3, C-API-56). */
import { afterEach, expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { ComposerCleanup } from "../../src/core/input/composer-cleanup.ts";
import { composerClearKeys } from "../../src/core/input/constants.ts";
import { replayControl, replayInput } from "./replay-input-fixture.ts";

afterEach(() => vi.useRealTimers());

test.each([
  "stalled",
  "failed nudges",
  "control characters",
  "controls and tabs",
  "accepted final nudge",
])("C-API-56 replay %s cannot pass its draft to successor input", async (scenario) => {
  vi.useFakeTimers();
  const prompt =
    scenario === "control characters"
      ? "re\u0001play"
      : scenario === "controls and tabs"
        ? "re\u0001\tplay"
        : "replay";
  const closing = new AbortController();
  const writes: string[] = [];
  let draft = "";
  let enters = 0;
  let emptyFrame: object | undefined;
  const terminal = {
    sendInput(value: string) {
      writes.push(value);
      if (value.startsWith("\u001b[200~")) draft += value.slice(6, -6);
      if (value === composerClearKeys) {
        draft = "";
        emptyFrame = {};
      }
      if (value !== "\r") return;
      enters++;
      if (scenario === "failed nudges" && enters > 1 && draft === "replay")
        throw new Error("physical nudge failed");
    },
  };
  const owner = new ComposerCleanup(
    terminal,
    () => false,
    closing.signal,
    () => closing.signal,
    () => emptyFrame,
  );
  const queue = new ControlQueue(
    replayInput(terminal, {
      snapshot: () => draft,
      staged: (screen, payload) => screen === payload,
    }),
    () => new Error("closed"),
    () => undefined,
    () => false,
    undefined,
    (work, signal) => owner.run(work, signal),
  );
  try {
    queue.markReady();
    const replay = queue.send(prompt, "message", undefined, replayControl(closing.signal));
    let replaySettled = false;
    const result = replay
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        replaySettled = true;
      });
    await vi.advanceTimersByTimeAsync(150);
    queue.markReady();
    const next = queue.send("next", "message");
    const nextDone = next.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes).not.toContain("\u001b[200~next\u001b[201~");
    if (scenario === "accepted final nudge") {
      expect(enters).toBe(3);
      expect(draft).toBe("replay");
      expect(replaySettled).toBe(false);
      // The physical write has settled, but native acceptance has not painted yet.
      await vi.advanceTimersByTimeAsync(500);
      expect(replaySettled).toBe(false);
      expect(writes).not.toContain("\u001b[200~next\u001b[201~");
      draft = ""; // Deferred native-frame observation, independently of sendInput.
    }
    await vi.advanceTimersByTimeAsync(1_300);
    if (scenario === "accepted final nudge") {
      expect(await result).toBeUndefined();
      expect(writes).not.toContain(composerClearKeys);
    } else {
      expect(await result).toMatchObject({ code: "wait_timeout" });
      expect(writes).toContain(composerClearKeys);
      expect(writes.indexOf(composerClearKeys)).toBeLessThan(
        writes.indexOf("\u001b[200~next\u001b[201~"),
      );
    }
    await nextDone;
    await expect(next).resolves.toBeUndefined();
    expect(draft).toBe("next");
  } finally {
    closing.abort();
    queue.close();
    await vi.runAllTimersAsync();
  }
});
