/** Session close owns the error until a physical replay write settles (PRD §5.3). */
import { expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import {
  cancellableSubmission,
  submissionControlOptions,
} from "../../src/core/input/submission-cancel.ts";

test.each([
  "resolve",
  "dispose",
  "cancel",
  "cancel-before-close",
])("Private replay: close retains session_not_running through %s settlement", async (race) => {
  const writing = Promise.withResolvers<void>();
  const closed = new Error("session_not_running");
  const abort = new AbortController();
  const remove = vi.spyOn(abort.signal, "removeEventListener");
  const queue = new ControlQueue(
    () => writing.promise,
    () => closed,
    () => undefined,
  );
  queue.markReady();
  let settled = false;
  const replay = queue
    .send(
      "replay",
      "message",
      undefined,
      submissionControlOptions(cancellableSubmission(undefined, abort.signal)),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    )
    .finally(() => {
      settled = true;
    });
  if (race === "cancel-before-close") abort.abort();
  queue.close();
  if (race === "cancel") abort.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  if (race === "resolve") writing.resolve();
  else writing.reject(new Error("Terminal is disposed."));
  expect(await replay).toBe(closed);
  expect(remove).toHaveBeenCalledOnce();
});
