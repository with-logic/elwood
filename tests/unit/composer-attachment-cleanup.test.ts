/** Failed image staging shares deferred queue cleanup (PRD §5.3, C-API-44/56). */
import { afterEach, expect, test, vi } from "vitest";
import { attachClaudeImages } from "../../src/claude/attach-images.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { ComposerCleanup } from "../../src/core/input/composer-cleanup.ts";
import { queuedInputSubmitter, writeQueuedInput } from "../../src/core/input/index.ts";

const restored = vi.fn(async () => true);
vi.mock("../../src/codex/images/clipboard.ts", () => ({
  clipboardImageSupported: () => true,
  snapshotClipboardText: async () => "prior clipboard",
  setClipboardImage: async () => undefined,
  restoreClipboardText: () => restored(),
}));
const { attachCodexImages } = await import("../../src/codex/images/attach.ts");
const clear = "\u0015\u000b";
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

test.each([
  ["claude", "after", "text"],
  ["codex", "after", "text"],
  ["claude", "during", "text"],
  ["codex", "during", "text"],
  ["claude", "after", "exclusive"],
  ["codex", "after", "exclusive"],
] as const)("C-API-44 %s cancellation %s final attachment cleans before %s successor bytes", async (agent, timing, successor) => {
  vi.useFakeTimers();
  const writes: string[] = [];
  const abort = new AbortController();
  const closing = new AbortController();
  const rawInput = new AbortController();
  let blocked = false;
  let screen = "❯ ";
  const terminal = {
    snapshot: () => ({ text: screen }),
    sendInput(data: string | Uint8Array) {
      const text = String(data);
      writes.push(text);
      if (text.includes("image.png") || text === "\u0016") {
        screen = "❯ [Image #1]";
        if (timing === "during") {
          blocked = true;
          abort.abort();
        }
      }
      if (text === clear) screen = "❯ ";
    },
  };
  const cleanup = new ComposerCleanup(
    terminal,
    () => blocked,
    closing.signal,
    () => rawInput.signal,
  );
  const queue = new ControlQueue(
    queuedInputSubmitter(terminal, {
      snapshot: () => screen,
      staged: () => false,
      blocked: () => blocked,
    }),
    () => new Error("closed"),
    () => undefined,
    () => false,
    undefined,
    (work, signal) => cleanup.run(work, signal),
  );
  try {
    const attach = agent === "claude" ? attachClaudeImages : attachCodexImages;
    const old = queue.send(
      "old",
      "prompt",
      async (signal) => {
        await attach(terminal, ["/image.png"], signal, () => blocked);
        blocked = true;
        abort.abort(); // successful adapter return, before the queue's post-attach check
      },
      { cancel: { signal: abort.signal, error: () => new Error("cancelled") } },
    );
    const rejected = expect(old).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(writes).not.toContain(clear);
    if (agent === "codex") expect(restored).toHaveBeenCalledOnce();
    const next =
      successor === "text"
        ? queue.send("next", "prompt")
        : queue.runExclusive("login", (signal) =>
            writeQueuedInput(terminal, "/next", "command", undefined, signal),
          );
    await vi.advanceTimersByTimeAsync(100);
    expect(writes.some((write) => write.includes("next"))).toBe(false);
    blocked = false;
    await vi.advanceTimersByTimeAsync(250);
    await next;
    expect(writes.slice(-3)).toEqual([
      clear,
      successor === "text" ? "\u001b[200~next\u001b[201~" : "/next",
      "\r",
    ]);
  } finally {
    closing.abort();
    queue.close();
  }
});
