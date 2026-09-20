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
