/** A no-start owner's release lets the same-process waiter acquire its own lease (C-LIFE-09). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { coordinatedAutoupdate } from "../../../src/runtime/update/lock.ts";
import * as waiting from "../../../src/runtime/update/waiting.ts";
import { tempDir } from "../../helpers/tmp.ts";

afterEach(() => vi.restoreAllMocks());

test("C-LIFE-09 a waiting launch retries after an observed owner refuses before starting", async () => {
  const root = tempDir("elwood-no-start-waiter-");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<void>();
  const attempts: string[] = [];
  const wait = waiting.waitForOwner;
  vi.spyOn(waiting, "waitForOwner").mockImplementation((...args) => {
    observed.resolve(); // Observe the real wait; retain its filesystem and recovery behavior.
    return wait(...args);
  });
  const owner = coordinatedAutoupdate(
    "codex",
    async () => {
      attempts.push("refused");
      entered.resolve();
      await release.promise;
      return { started: false };
    },
    { root },
  );
  let waiter: Promise<void> | undefined;
  try {
    await entered.promise;
    waiter = coordinatedAutoupdate(
      "codex",
      () => {
        attempts.push("waiter");
        return Promise.resolve();
      },
      { root, pollMs: 1 },
    );
    await observed.promise;
    release.resolve();
    await Promise.all([owner, waiter]);
    expect(attempts).toEqual(["refused", "waiter"]);
    expect(existsSync(join(root, "codex.completed"))).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled([owner, waiter]);
  }
});
