/**
 * A caller that recovered a dead lease does not repeat a peer's update (PRD §9.2,
 * C-PERF-04). Recovery vacates the lease path before the recoverer's own claim; the peer
 * here claims, updates, and releases inside that gap.
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const gap = vi.hoisted(() => ({
  recovery: "",
  peer: undefined as (() => Promise<unknown>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rmdir: async (...args: Parameters<typeof actual.rmdir>) => {
      const result = await actual.rmdir(...args);
      if (String(args[0]) === gap.recovery) {
        const { peer } = gap;
        gap.peer = undefined;
        await peer?.();
      }
      return result;
    },
  };
});

test.each([
  ["completed", () => Promise.resolve()],
  ["failed", () => Promise.reject(new Error("installer failed"))],
])("C-PERF-04 a waiter that recovered a dead lease skips its update once a peer's update %s", async (_outcome, peerUpdate) => {
  const root = tempDir("elwood-update-lock-recovered-peer-");
  const path = updateLockPath("codex", root);
  gap.recovery = `${path}.recovery`;
  mkdirSync(path);
  writeFileSync(join(path, "owner"), "99999999:00000000-0000-4000-8000-000000000000");
  const stale = new Date(Date.now() - 1_000);
  utimesSync(path, stale, stale);
  const options = { root, pollMs: 1, staleMs: 1 };
  const attempts: string[] = [];
  // A failed update is an attempt too: it is shared once, never retried by the recoverer.
  gap.peer = () =>
    coordinatedAutoupdate(
      "codex",
      () => {
        attempts.push("peer");
        return peerUpdate();
      },
      options,
    ).catch(() => undefined);
  await coordinatedAutoupdate("codex", async () => void attempts.push("waiter"), options);
  expect(gap.peer).toBeUndefined();
  expect(attempts).toEqual(["peer"]);
});
