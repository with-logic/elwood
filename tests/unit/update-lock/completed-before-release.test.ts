/** A completion sampled before lease release still deduplicates the contender (PRD §9.2, C-PERF-04). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { coordinatedAutoupdate } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const window = vi.hoisted(() => ({
  ownerReleasing: Promise.withResolvers<void>(),
  allowRelease: Promise.withResolvers<void>(),
  ownerRetired: Promise.withResolvers<void>(),
  sampleCompletion: false,
  pauseRelease: false,
}));
beforeEach(() => {
  Object.assign(window, {
    ownerReleasing: Promise.withResolvers<void>(),
    allowRelease: Promise.withResolvers<void>(),
    ownerRetired: Promise.withResolvers<void>(),
    sampleCompletion: false,
    pauseRelease: false,
  });
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (!(window.pauseRelease && String(args[1]).includes(".lock.released.")))
        return actual.rename(...args);
      window.pauseRelease = false;
      window.ownerReleasing.resolve();
      await window.allowRelease.promise;
      const result = await actual.rename(...args);
      window.ownerRetired.resolve();
      return result;
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const text = await actual.readFile(...args);
      if (window.sampleCompletion && String(args[0]).endsWith(".completed")) {
        window.sampleCompletion = false;
        window.allowRelease.resolve();
        await window.ownerRetired.promise;
      }
      return text;
    },
  };
});

test("C-PERF-04 completion sampled before lease release skips the duplicate updater", async () => {
  const root = tempDir("elwood-update-completed-release-");
  const attempts: string[] = [];
  window.pauseRelease = true;
  const owner = coordinatedAutoupdate("codex", async () => void attempts.push("owner"), { root });
  try {
    await window.ownerReleasing.promise;
    // Capture the completed generation, then let its real lease retire before the path check.
    window.sampleCompletion = true;
    const contender = coordinatedAutoupdate("codex", async () => void attempts.push("contender"), {
      root,
      pollMs: 1,
    });
    await Promise.all([owner, contender]);
    expect(window.sampleCompletion).toBe(false);
    expect(attempts).toEqual(["owner"]);
  } finally {
    window.pauseRelease = false;
    window.allowRelease.resolve();
    await owner;
  }
});

test("C-PERF-04 recovering a completed owner's stale lease does not repeat its update", async () => {
  const root = tempDir("elwood-update-completed-stale-");
  const lease = join(root, "codex.lock");
  const generation = "00000000-0000-4000-8000-000000000000";
  mkdirSync(lease);
  writeFileSync(join(lease, "owner"), `99999999:${generation}`);
  writeFileSync(join(root, "codex.completed"), generation);
  const update = vi.fn(async () => undefined);
  await coordinatedAutoupdate("codex", update, { root, staleMs: 0, pollMs: 1 });
  expect(update).not.toHaveBeenCalled();
});
