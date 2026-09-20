/** Native draft consumption, not PTY dispatch, releases a cancelled composer (C-API-56). */
import { afterEach, expect, test, vi } from "vitest";
import { ComposerCleanup, stageComposer } from "../../src/core/input/composer-cleanup.ts";

afterEach(() => vi.useRealTimers());

function setup(initiallyEmpty = false) {
  vi.useFakeTimers();
  let frame = {};
  let empty = initiallyEmpty;
  const terminal = { sendInput: vi.fn(), settled: () => Promise.resolve() };
  const lifetime = new AbortController();
  const human = new AbortController();
  const owner = new ComposerCleanup(
    terminal,
    () => false,
    lifetime.signal,
    () => human.signal,
    () => (empty ? frame : undefined),
  );
  const fail = () =>
    owner.run(() => {
      stageComposer(terminal);
      throw new Error("cancelled draft");
    }, lifetime.signal);
  return {
    terminal,
    owner,
    lifetime,
    human,
    fail,
    renderEmpty: () => {
      empty = true;
      frame = {};
    },
  };
}

test("C-API-56 delayed native clear holds successor until a fresh empty composer", async () => {
  const { terminal, owner, lifetime, fail, renderEmpty } = setup();
  const failed = fail().catch((error: unknown) => error);
  const work = vi.fn(async () => {});
  const successor = failed.then(() => owner.run(work, lifetime.signal));
  await vi.advanceTimersByTimeAsync(200);
  expect(terminal.sendInput).toHaveBeenCalledExactlyOnceWith("\u0015\u000b");
  expect(work).not.toHaveBeenCalled();
  renderEmpty();
  await vi.advanceTimersByTimeAsync(50);
  await successor;
  expect(work).toHaveBeenCalledOnce();
});

test("C-API-56 an unchanged old empty snapshot cannot acknowledge a swallowed clear", async () => {
  const { owner, lifetime, fail, renderEmpty } = setup(true);
  const failed = expect(fail()).rejects.toThrow("cancelled draft");
  await vi.advanceTimersByTimeAsync(1_001);
  await failed;
  const work = vi.fn(async () => {});
  const rejected = expect(owner.run(work, lifetime.signal)).rejects.toMatchObject({
    code: "wait_timeout",
  });
  await vi.advanceTimersByTimeAsync(1_001);
  await rejected;
  expect(work).not.toHaveBeenCalled();
  const next = owner.run(work, lifetime.signal);
  await vi.advanceTimersByTimeAsync(1);
  renderEmpty();
  await vi.advanceTimersByTimeAsync(50);
  await next;
  expect(work).toHaveBeenCalledOnce();
});

test.each([
  "blocked",
  "render",
] as const)("C-API-56 %s after a clear write retains ownership", async (mode) => {
  let blocked = false;
  let frame: object | undefined;
  const terminal = {
    renderFailed: false,
    sendInput: vi.fn(() => {
      blocked = mode === "blocked";
      terminal.renderFailed = mode === "render";
    }),
  };
  const closing = new AbortController();
  const owner = new ComposerCleanup(
    terminal,
    () => blocked,
    closing.signal,
    () => closing.signal,
    () => frame,
  );
  await expect(
    owner.run(() => {
      stageComposer(terminal);
      throw new Error("original failure");
    }, closing.signal),
  ).rejects.toThrow("original failure");
  terminal.renderFailed = false;
  blocked = false;
  terminal.sendInput.mockImplementation(() => {
    frame = {};
  });
  const work = vi.fn(async () => {});
  await owner.run(work, closing.signal);
  expect(terminal.sendInput).toHaveBeenCalledTimes(2);
  expect(work).toHaveBeenCalledOnce();
});

test.each([
  "human",
  "closing",
] as const)("C-API-56 %s interrupts acknowledgement without late clear writes", async (mode) => {
  const { terminal, owner, lifetime, human, fail } = setup();
  const failed = expect(fail()).rejects.toThrow("cancelled draft");
  await vi.advanceTimersByTimeAsync(1);
  (mode === "human" ? human : lifetime).abort(new Error("interrupted"));
  await failed;
  const work = vi.fn(async () => {});
  const next = owner.run(work, lifetime.signal);
  if (mode === "closing") await expect(next).rejects.toThrow("interrupted");
  else await next;
  expect(work).toHaveBeenCalledTimes(mode === "human" ? 1 : 0);
  expect(terminal.sendInput).toHaveBeenCalledTimes(1);
});

test("C-API-56 closing between native acknowledgement and token release stays closed", async () => {
  const closing = new AbortController();
  let cleared = false;
  const terminal = {
    sendInput: vi.fn(() => {
      cleared = true;
    }),
  };
  const owner = new ComposerCleanup(
    terminal,
    () => false,
    closing.signal,
    () => closing.signal,
    () => {
      if (!cleared) return undefined;
      queueMicrotask(() => closing.abort());
      return {};
    },
  );
  await expect(
    owner.run(() => {
      stageComposer(terminal);
      throw new Error("original");
    }, closing.signal),
  ).rejects.toThrow("original");
  expect(terminal.sendInput).toHaveBeenCalledOnce();
});

test("C-API-56 an exclusive preparation deadline cancels native acknowledgement", async () => {
  const { owner, terminal, lifetime, fail } = setup();
  const failed = expect(fail()).rejects.toThrow("cancelled draft");
  await vi.advanceTimersByTimeAsync(1_001);
  await failed;
  const preparation = new AbortController();
  const work = vi.fn(async () => {});
  const next = expect(owner.run(work, preparation.signal)).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(50);
  preparation.abort(new Error("deadline"));
  await next;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(work).not.toHaveBeenCalled();
  expect(terminal.sendInput).toHaveBeenCalledTimes(2);
  lifetime.abort();
});
