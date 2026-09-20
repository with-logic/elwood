/** Exclusive deadlines bound draft cleanup without revoking owned dialogs (C-API-43/55/56). */
import { afterEach, expect, test, vi } from "vitest";
import { runSessionLogin } from "../../src/claude/login/session-login.ts";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { ComposerCleanup, stageComposer } from "../../src/core/input/composer-cleanup.ts";
import { PickerTransactions } from "../../src/runtime/session/picker.ts";

afterEach(() => vi.useRealTimers());

function setup() {
  const terminal = { snapshot: () => ({ text: "❯ " }), sendInput: vi.fn() };
  const closing = new AbortController();
  let blocked = true;
  const cleanup = new ComposerCleanup(
    terminal,
    () => blocked,
    closing.signal,
    () => closing.signal,
  );
  stageComposer(terminal);
  cleanup.defer();
  const queue = new ControlQueue(
    async () => {},
    () => new Error("closed"),
    () => {},
    undefined,
    undefined,
    (work, signal) => cleanup.run(work, signal),
  );
  queue.markReady();
  return {
    terminal,
    queue,
    release: () => {
      blocked = false;
    },
  };
}

test.each([
  "list_models",
  "set_model",
  "login",
] as const)("C-API-43/55/56 %s expires during deferred cleanup and frees the queue", async (kind) => {
  vi.useFakeTimers();
  const { terminal, queue, release } = setup();
  const work = vi.fn(async () => undefined);
  let failure: unknown;
  try {
    const operation =
      kind === "login"
        ? runSessionLogin(
            { controlQueue: queue, terminal, blocked: () => true, onReady: () => () => {} },
            { provideCode: () => "unused", timeoutMs: 50 },
          )
        : new PickerTransactions({
            controlQueue: queue,
            terminal,
            blocked: () => true,
            picker: () => claudeModelPicker,
            submitDirect: work,
          }).run(kind, claudeModelPicker, 50, work);
    void operation.catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(failure).toMatchObject({
      code: kind === "login" ? "login_timeout" : "model_automation_failed",
    });
    expect(terminal.sendInput).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    release();
    const successor = queue.runExclusive("login", work);
    await vi.advanceTimersByTimeAsync(100);
    await successor;
    expect(terminal.sendInput).toHaveBeenCalledExactlyOnceWith("\u0015\u000b");
    expect(work).toHaveBeenCalledOnce();
  } finally {
    queue.close();
  }
});

test("C-API-55 cancellation after exclusive work starts preserves its dialog cleanup signal", async () => {
  const { terminal, queue, release } = setup();
  release();
  const deadline = new AbortController();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const operation = queue.runExclusive(
    "set_model",
    async (closed) => {
      entered.resolve();
      await finish.promise;
      expect(closed.aborted).toBe(false);
      await terminal.sendInput("\u001b");
    },
    { signal: deadline.signal, error: () => new Error("deadline") },
  );
  try {
    await entered.promise;
    deadline.abort();
    finish.resolve();
    await operation;
    expect(terminal.sendInput.mock.calls).toEqual([["\u0015\u000b"], ["\u001b"]]);
  } finally {
    finish.resolve();
    queue.close();
  }
});
