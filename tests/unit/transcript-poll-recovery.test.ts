/**
 * The poll recovery the Claude and Codex transcript watchers share (PRD §5.4, C-CLAUDE-15,
 * C-CODEX-20): a scan that throws stops the watcher and routes `transcript_poll_stopped`, and
 * neither a throwing `finish()` nor a throwing diagnostic escapes the timer.
 */

import { expect, test, vi } from "vitest";
import { recoverFromPollError } from "../../src/core/transcript/poll-recovery.ts";

const failure = new Error("scan failed");

function watcherDouble(finish: () => void = () => undefined) {
  return { finish: vi.fn(finish), stop: vi.fn() };
}

test("C-CODEX-20 recovery finishes the watcher and routes the poll failure", () => {
  const watcher = watcherDouble();
  const onPollError = vi.fn();
  recoverFromPollError(watcher, onPollError, failure);
  expect(watcher.finish).toHaveBeenCalledOnce();
  expect(watcher.stop).not.toHaveBeenCalled();
  expect(onPollError).toHaveBeenCalledWith(failure);
});

test("C-CODEX-20 a finish() that throws still stops the timer and routes the failure", () => {
  const watcher = watcherDouble(() => {
    throw new Error("drain listener failed");
  });
  const onPollError = vi.fn();
  recoverFromPollError(watcher, onPollError, failure);
  expect(watcher.stop).toHaveBeenCalledOnce();
  expect(onPollError).toHaveBeenCalledWith(failure);
});

test("C-CODEX-20 a throwing or absent poll-error listener does not escape", () => {
  const watcher = watcherDouble();
  const throwing = vi.fn(() => {
    throw new Error("diagnostic listener failed");
  });
  expect(() => recoverFromPollError(watcher, throwing, failure)).not.toThrow();
  expect(throwing).toHaveBeenCalledWith(failure);
  expect(() => recoverFromPollError(watcher, undefined, failure)).not.toThrow();
  expect(watcher.finish).toHaveBeenCalledTimes(2);
});
