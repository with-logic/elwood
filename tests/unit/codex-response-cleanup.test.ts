/** Native response proofs await cancellation and retry failed cleanup (PRD §9). */
import { expect, test } from "vitest";
import { closeNativeResponse, trackResponseKill } from "../e2e/codex-response-cleanup.ts";

test("native response cleanup awaits observed kill attempts without retrying a successful close", async () => {
  const attempts: Promise<void>[] = [];
  let killed = false;
  trackResponseKill(undefined, attempts);
  trackResponseKill(
    {
      kill: () => {
        killed = true;
        return Promise.resolve();
      },
    },
    attempts,
  );
  await closeNativeResponse(async () => undefined, undefined, attempts);
  expect(killed).toBe(true);
  expect(attempts).toHaveLength(1);
});

test("native response cleanup retries teardown and preserves close and kill failures", async () => {
  const attempts: Promise<void>[] = [];
  const closeError = new Error("close");
  const killError = new Error("kill");
  let retried = false;
  trackResponseKill(
    {
      kill: () => {
        return Promise.reject(killError);
      },
    },
    attempts,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const result = closeNativeResponse(
    () => {
      return Promise.reject(closeError);
    },
    {
      teardown: () => {
        retried = true;
        return Promise.resolve();
      },
    },
    attempts,
  );
  await expect(result).rejects.toMatchObject({ errors: [closeError, killError] });
  expect(retried).toBe(true);
});

test("native response cleanup preserves a failed teardown retry", async () => {
  const closeError = new Error("close");
  const teardownError = new Error("teardown");
  await expect(
    closeNativeResponse(
      () => {
        return Promise.reject(closeError);
      },
      {
        teardown: () => {
          return Promise.reject(teardownError);
        },
      },
      [],
    ),
  ).rejects.toMatchObject({ errors: [closeError, teardownError] });
});

test("native response cleanup preserves close failure when startup produced no live session", async () => {
  const error = new Error("startup close");
  await expect(
    closeNativeResponse(
      () => {
        return Promise.reject(error);
      },
      undefined,
      [],
    ),
  ).rejects.toMatchObject({ errors: [error] });
});
