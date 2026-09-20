/** Raw edits remain caller-owned until a submission establishes a clean generation (C-API-56). */
import { expect, test, vi } from "vitest";
import {
  ComposerCleanup,
  stageComposer,
  submittedComposer,
} from "../../src/core/input/composer-cleanup.ts";

test.each([
  false,
  true,
])("C-API-56 raw input cannot be reacquired by later failed staging (during Enter: %s)", async (duringEnter) => {
  let raw = new AbortController();
  const signal = new AbortController().signal;
  const terminal = { sendInput: vi.fn() };
  const owner = new ComposerCleanup(
    terminal,
    () => false,
    signal,
    () => raw.signal,
    () => terminal.sendInput.mock.calls.at(-1),
  );
  const intervene = () => {
    raw.abort();
    raw = new AbortController();
  };
  stageComposer(terminal);
  owner.defer();
  intervene();
  const failed = () =>
    owner.run(() => {
      stageComposer(terminal);
      throw new Error("staging failed");
    }, signal);
  await expect(failed()).rejects.toThrow("staging failed");
  expect(terminal.sendInput).not.toHaveBeenCalled();

  await owner.run(() => {
    stageComposer(terminal);
    if (duringEnter) intervene();
    submittedComposer(terminal);
    return Promise.resolve();
  }, signal);
  await expect(failed()).rejects.toThrow("staging failed");
  expect(terminal.sendInput.mock.calls).toEqual(duringEnter ? [] : [["\u0015\u000b"]]);
});

test("C-API-56 raw intervention releases a pending cleanup wait without clearing the draft", async () => {
  let raw = new AbortController();
  const signal = new AbortController().signal;
  const terminal = { sendInput: vi.fn() };
  const owner = new ComposerCleanup(
    terminal,
    () => true,
    signal,
    () => raw.signal,
    () => terminal.sendInput.mock.calls.at(-1),
  );
  stageComposer(terminal);
  owner.defer();
  const work = vi.fn(() => Promise.resolve());
  const next = owner.run(work, signal);
  await Promise.resolve();
  raw.abort();
  raw = new AbortController();
  await next;
  expect(work).toHaveBeenCalledOnce();
  expect(terminal.sendInput).not.toHaveBeenCalled();
});
