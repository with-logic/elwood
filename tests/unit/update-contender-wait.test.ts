/** Contender waiting is bounded and never evicts a live owner (PRD §9.2, C-PERF-04). */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../src/runtime/update/lock.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

test("C-PERF-04 contender wait expires without evicting the active owner", async () => {
  const root = tempDir("elwood-update-wait-");
  let release!: () => void;
  const owner = coordinatedAutoupdate(
    "codex",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    { root },
  );
  await expect.poll(() => typeof release).toBe("function");
  const path = updateLockPath("codex", root);
  const before = await readFile(join(path, "owner"), "utf8");
  const update = vi.fn(() => Promise.resolve());
  await expect(
    coordinatedAutoupdate("codex", update, { root, waitMs: 10, pollMs: 1 }),
  ).rejects.toMatchObject({
    code: "codex_update_failed",
    details: { updateReason: "active_owner" },
  });
  expect(update).not.toHaveBeenCalled();
  expect(await readFile(join(path, "owner"), "utf8")).toBe(before);
  release();
  await owner;
});

test("C-PERF-04 a live owner is never evicted solely because staleMs elapsed", async () => {
  const root = tempDir("elwood-update-live-");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  const owner = coordinatedAutoupdate(
    "codex",
    async () => {
      attempts += 1;
      entered.resolve();
      await release.promise;
    },
    { root },
  );
  try {
    await entered.promise;
    await expect(
      coordinatedAutoupdate(
        "codex",
        () => {
          attempts += 1;
          return Promise.resolve();
        },
        { root, pollMs: 2, staleMs: 5, waitMs: 40 },
      ),
    ).rejects.toMatchObject({
      details: { updateReason: "active_owner" },
    });
    expect(attempts).toBe(1);
  } finally {
    release.resolve();
    await owner;
  }
});

test("C-LIFE-11 a contender that stops waiting starts from the installed CLI with update_active", async () => {
  const root = tempDir("elwood-update-wait-warning-");
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const owner = coordinatedAutoupdate(
    "codex",
    () => {
      entered.resolve();
      return release.promise;
    },
    { root },
  );
  await entered.promise;
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  setPlatformForTests("darwin");
  setUpdateCoordinatorForTests((adapter, update) =>
    coordinatedAutoupdate(adapter, update, { root, pollMs: 1, waitMs: 10 }),
  );
  const commands: string[] = [];
  setCommandRunnerForTests((_command, args) => {
    commands.push(args.join(" "));
    return { status: 0, stdout: "codex-cli 0.154.0", stderr: "" };
  });
  try {
    expect(await preflightCodex(false, true)).toMatchObject({
      code: "agent_update_failed",
      errorCode: "update_active",
      installedVersion: "0.154.0",
      raw: "",
    });
    expect(commands.some((command) => command.includes("codex update"))).toBe(false);
  } finally {
    release.resolve();
    await owner;
    resetAutoupdateForTests();
  }
});
