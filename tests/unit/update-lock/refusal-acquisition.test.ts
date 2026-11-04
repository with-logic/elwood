/** Only the relevant owner's refusal authorizes another claim (PRD §9.2, C-LIFE-09). */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { acquireUpdateLease } from "../../../src/runtime/update/acquire.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const race = vi.hoisted(() => ({ path: "", afterRead: () => {} }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const text = await actual.readFile(...args);
      if (String(args[0]) === race.path) race.afterRead();
      return text;
    },
  };
});

test.each([
  "b",
  "unreadable",
])("C-LIFE-09 observing a later %s owner invalidates A's retry authority", async (successor) => {
  const root = tempDir("elwood-relevant-refusal-");
  const leasePath = updateLockPath("codex", root);
  const ownerPath = join(leasePath, "owner");
  const refusal = join(root, "codex.refused");
  mkdirSync(leasePath);
  writeFileSync(ownerPath, `${process.pid}:a`);
  writeFileSync(refusal, "a"); // A durable receipt from the earlier protocol.
  race.path = ownerPath;
  let observed = false;
  race.afterRead = () => {
    if (observed) rmSync(leasePath, { recursive: true });
  };
  let claims = 0;
  try {
    const acquired = await acquireUpdateLease({
      adapter: "codex",
      leasePath,
      owner: { pid: process.pid, token: "c" },
      completionMarkerPath: join(root, "codex.completed"),
      refusalReceiptPath: refusal,
      pollMs: 1,
      staleMs: 30_000,
      waitUntilMs: performance.now() + 1_000,
      claim: () => {
        if (++claims === 1) {
          observed = true;
          writeFileSync(ownerPath, successor === "b" ? `${process.pid}:b` : "malformed");
          return Promise.resolve("contended");
        }
        mkdirSync(leasePath);
        writeFileSync(ownerPath, `${process.pid}:c`);
        return Promise.resolve("claimed");
      },
    });
    expect(acquired).toBe(false);
    expect(claims).toBe(1);
  } finally {
    race.afterRead = () => {};
  }
});

test("C-LIFE-09 failed receipt invalidation returns no-attempt without updater invocation", async () => {
  const root = tempDir("elwood-uncleared-refusal-");
  mkdirSync(join(root, "codex.refused")); // unlink fails structurally even as root.
  let updates = 0;
  const result = await coordinatedAutoupdate("codex", () => Promise.resolve(void updates++), {
    root,
  });
  expect(result).toMatchObject({ started: false, error: expect.any(Error) });
  expect(updates).toBe(0);
  expect(existsSync(updateLockPath("codex", root))).toBe(false);
  expect(existsSync(join(root, "codex.completed"))).toBe(false);
});
