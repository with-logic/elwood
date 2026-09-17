/** Registered group liveness and crash-left owner writes (PRD §9.2, C-PERF-04). */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runProbe } from "../../src/runtime/probe.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../src/runtime/update/lock.ts";
import { ownerIsAlive } from "../../src/runtime/update/owner.ts";
import { ProbeRegistration } from "../../src/runtime/update/probe-registration.ts";
import { tempDir } from "../helpers/tmp.ts";

test("C-PERF-04 an active parent retains its callback between registered probe groups", () => {
  expect(
    ownerIsAlive({
      pid: process.pid,
      token: "abc",
      cleanupGroup: 2_147_483_600,
      activeProbe: true,
    }),
  ).toBe(true);
});

test("C-PERF-04 stale recovery removes a crash-left owner.next before claiming a new generation", async () => {
  const root = tempDir("elwood-owner-next-");
  const path = updateLockPath("codex", root);
  await mkdir(path);
  await writeFile(join(path, "owner"), "2147483600:abc");
  await writeFile(join(path, "owner.next"), "2147483600:abc:2147483601:active");
  let called = false;
  await coordinatedAutoupdate(
    "codex",
    () => {
      called = true;
      return Promise.resolve();
    },
    { root, pollMs: 1, staleMs: 0, waitMs: 100 },
  );
  expect(called).toBe(true);
});

test("C-PERF-04 normal group confirmation waits for remaining work without signaling", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60)"], { detached: true });
  const registry = new ProbeRegistration(() => Promise.resolve());
  await registry.register(child.pid!, new AbortController().signal);
  await expect(registry.unfinishedGroup()).resolves.toBeUndefined();
  expect(child.signalCode).toBeNull();
});

test("C-PERF-04 a contender cannot enter the live callback gap between version and update", async () => {
  const root = tempDir("elwood-probe-gap-");
  const events: string[] = [];
  let finish!: () => void;
  const paused = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const owner = coordinatedAutoupdate(
    "codex",
    async () => {
      await runProbe(process.execPath, ["-e", "process.exit(0)"]);
      events.push("between probes");
      await paused;
      events.push("updater runs");
    },
    { root, staleMs: 0, pollMs: 1 },
  );
  try {
    await expect.poll(() => events).toContain("between probes");
    await expect(
      coordinatedAutoupdate(
        "codex",
        () => {
          events.push("duplicate updater");
          return Promise.resolve();
        },
        { root, staleMs: 0, pollMs: 1, waitMs: 100 },
      ),
    ).rejects.toMatchObject({
      details: { updateReason: "active_owner" },
    });
    expect(events).toEqual(["between probes"]);
  } finally {
    finish();
    await owner;
  }
  expect(events).toEqual(["between probes", "updater runs"]);
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
