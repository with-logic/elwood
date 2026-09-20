/** Cleanup cancellation and failed writes preserve draft authority (PRD §5.3, C-API-56). */
import { expect, test, vi } from "vitest";
import {
  ComposerCleanup,
  requestComposerCleanup,
  stageComposer,
  submittedComposer,
} from "../../src/core/input/composer-cleanup.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const clear = "\u0015\u000b";

test("C-API-56 failed cleanup retains the draft and original error until a successful clear", async () => {
  let fail = true;
  const write = vi.fn(() => {
    if (fail) throw new Error("PTY failed");
  });
  const terminal = { sendInput: write };
  const signal = new AbortController().signal;
  const owner = new ComposerCleanup(
    terminal,
    () => false,
    signal,
    () => signal,
    () => terminal.sendInput.mock.calls.at(-1),
  );
  await expect(
    owner.run(() => {
      stageComposer(terminal);
      throw new Error("original failure");
    }, signal),
  ).rejects.toThrow("original failure");
  expect(write).toHaveBeenCalledExactlyOnceWith(clear);
  const successor = vi.fn(async () => undefined);
  await expect(owner.run(successor, signal)).rejects.toMatchObject({ code: "wait_timeout" });
  expect(successor).not.toHaveBeenCalled();
  fail = false;
  await owner.run(successor, signal);
  expect(write).toHaveBeenCalledTimes(3);
  expect(successor).toHaveBeenCalledOnce();
});

test("C-API-56 human input during failed-operation observation revokes cleanup", async () => {
  const rendering = Promise.withResolvers<void>();
  const terminal = { sendInput: vi.fn(), settled: () => rendering.promise };
  const human = new AbortController();
  const signal = new AbortController().signal;
  const owner = new ComposerCleanup(
    terminal,
    () => false,
    signal,
    () => human.signal,
    () => terminal.sendInput.mock.calls.at(-1),
  );
  const failed = owner.run(() => {
    stageComposer(terminal);
    throw new Error("original failure");
  }, signal);
  const rejected = expect(failed).rejects.toThrow("original failure");
  await tick();
  human.abort();
  rendering.resolve();
  await rejected;
  await owner.run(async () => undefined, signal);
  expect(terminal.sendInput).not.toHaveBeenCalled();
});

test("C-API-56 close during an awaited clear drops its token and prevents later work", async () => {
  const writing = Promise.withResolvers<void>();
  const terminal = { sendInput: vi.fn(() => writing.promise) };
  const closing = new AbortController();
  const signal = new AbortController().signal;
  const owner = new ComposerCleanup(
    terminal,
    () => false,
    closing.signal,
    () => signal,
    () => terminal.sendInput.mock.calls.at(-1),
  );
  const failed = owner.run(() => {
    stageComposer(terminal);
    throw new Error("failed");
  }, signal);
  const rejected = expect(failed).rejects.toThrow("failed");
  await tick();
  expect(terminal.sendInput).toHaveBeenCalledOnce();
  closing.abort(new Error("closed"));
  writing.resolve();
  await rejected;
  const successor = vi.fn(async () => undefined);
  await expect(owner.run(successor, signal)).rejects.toThrow("closed");
  expect(successor).not.toHaveBeenCalled();
});

test("C-API-56 an unstaged failure and a held direct attach never clear unrelated input", async () => {
  const terminal = { sendInput: vi.fn() };
  await requestComposerCleanup(terminal, () => true);
  const signal = new AbortController().signal;
  const owner = new ComposerCleanup(
    terminal,
    () => false,
    signal,
    () => signal,
    () => terminal.sendInput.mock.calls.at(-1),
  );
  await expect(
    owner.run(() => {
      throw new Error("before staging");
    }, signal),
  ).rejects.toThrow("before staging");
  expect(terminal.sendInput).not.toHaveBeenCalled();
});

test("C-API-56 registration defers cleanup while unregistered terminals use best-effort clearing", async () => {
  const terminal = { sendInput: vi.fn() };
  stageComposer(terminal);
  submittedComposer(terminal);
  await requestComposerCleanup(terminal);
  expect(terminal.sendInput).toHaveBeenCalledExactlyOnceWith(clear);
  terminal.sendInput.mockClear();
  const signal = new AbortController().signal;
  const owner = new ComposerCleanup(
    terminal,
    () => false,
    signal,
    () => signal,
    () => terminal.sendInput.mock.calls.at(-1),
  );
  stageComposer(terminal);
  await requestComposerCleanup(terminal);
  expect(terminal.sendInput).not.toHaveBeenCalled();
  await owner.run(() => Promise.resolve(), signal);
  expect(terminal.sendInput).toHaveBeenCalledExactlyOnceWith(clear);
});

test("C-API-56 preparation cancelled after flush resolves never starts work", async () => {
  const preparation = new AbortController();
  const closing = new AbortController();
  const terminal = { sendInput: vi.fn() };
  const owner = new ComposerCleanup(
    terminal,
    () => false,
    closing.signal,
    () => closing.signal,
    () => terminal.sendInput.mock.calls.at(-1),
  );
  const work = vi.fn(async () => undefined);
  // flush checks synchronously; this queued abort runs before run resumes its await.
  queueMicrotask(() => preparation.abort(new Error("preparation expired")));
  await expect(owner.run(work, preparation.signal)).rejects.toThrow("preparation expired");
  expect(work).not.toHaveBeenCalled();
  expect(terminal.sendInput).not.toHaveBeenCalled();
});
