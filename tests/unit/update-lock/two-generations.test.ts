/** An observed owner still counts after two generations retire before sampling completion (C-PERF-04). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const window = vi.hoisted(() => ({
  ownerPath: "",
  afterRead: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const text = await actual.readFile(...args);
      if (window.afterRead !== undefined && String(args[0]) === window.ownerPath) {
        const afterRead = window.afterRead;
        window.afterRead = undefined;
        await afterRead();
      }
      return text;
    },
  };
});

test("C-PERF-04 observing A before A and B both complete prevents a third update", async () => {
  const root = tempDir("elwood-update-two-generations-");
  const completion = join(root, "codex.completed");
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const attempts: string[] = [];
  const owner = coordinatedAutoupdate(
    "codex",
    async () => {
      attempts.push("A");
      entered.resolve();
      await finish.promise;
    },
    { root },
  );
  await entered.promise;
  let completedA: string | undefined;
  let completedB: string | undefined;
  window.ownerPath = join(updateLockPath("codex", root), "owner");
  window.afterRead = async () => {
    // Return A's real owner record only after A and B have fully retired their leases.
    finish.resolve();
    await owner;
    completedA = readFileSync(completion, "utf8");
    await coordinatedAutoupdate("codex", () => Promise.resolve(void attempts.push("B")), { root });
    completedB = readFileSync(completion, "utf8");
  };
  try {
    await coordinatedAutoupdate("codex", () => Promise.resolve(void attempts.push("C")), { root });
    expect(attempts).toEqual(["A", "B"]);
    expect(completedA).toBeTruthy();
    expect(completedB).not.toBe(completedA);
    expect(existsSync(updateLockPath("codex", root))).toBe(false);
  } finally {
    window.afterRead = undefined;
    finish.resolve();
    await owner;
  }
});
