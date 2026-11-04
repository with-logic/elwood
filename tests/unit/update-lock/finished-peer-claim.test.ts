/** A peer finishing before a swept claimant resumes still invalidates caches (C-PERF-04). */
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import {
  detectCodexCliCapabilities,
  preflightCodex,
  resetCodexPreflightCacheForTests,
} from "../../../src/codex/preflight.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../../src/runtime/seams.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../../src/runtime/update/once.ts";
import { tempDir } from "../../helpers/tmp.ts";

const race = vi.hoisted(() => ({ hold: false, staged: "", resume: () => Promise.resolve() }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const path = String(args[0]);
      if (race.hold && path.includes(".claim.") && path.endsWith("/owner")) {
        race.hold = false;
        race.staged = path;
        await race.resume();
      }
      return actual.writeFile(...args);
    },
  };
});
beforeEach(() => {
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
  setPlatformForTests("darwin");
});

test.each([
  true,
  false,
])("C-PERF-04 swept claim with finished peer=%s handles cached compatibility", async (peer) => {
  const root = tempDir("elwood-finished-peer-");
  const directory = { cwd: tempDir("elwood-finished-peer-workspace-") };
  let installed = false;
  let versions = 0;
  let helps = 0;
  let localUpdates = 0;
  let peerUpdates = 0;
  setCommandRunnerForTests((_shell, args) => {
    const command = args.join(" ");
    if (command.includes("codex update")) localUpdates++;
    else if (command.includes("--help")) {
      helps++;
      return { status: 0, stdout: installed ? "" : "--dangerously-bypass-hook-trust", stderr: "" };
    } else versions++;
    return {
      status: 0,
      stdout: peer && !installed ? "codex-cli 0.0.1" : "codex-cli 0.150.0",
      stderr: "",
    };
  });
  if (peer)
    await expect(preflightCodex(false, false, directory)).rejects.toMatchObject({
      code: "codex_version_unsupported",
    });
  else await preflightCodex(false, false, directory);
  expect(await detectCodexCliCapabilities(directory)).toEqual({ supportsHookTrustBypass: true });
  const resume = Promise.withResolvers<void>();
  Object.assign(race, { hold: true, staged: "", resume: () => resume.promise });
  setUpdateCoordinatorForTests((adapter, update) =>
    coordinatedAutoupdate(adapter, update, { root, pollMs: 1, waitMs: 1_000 }),
  );
  const pending = preflightCodex(false, true, directory);
  void pending.catch(() => {});
  try {
    await expect.poll(() => race.staged, { timeout: 1_000 }).not.toBe("");
    if (peer) {
      await coordinatedAutoupdate(
        "codex",
        () => {
          peerUpdates++;
          installed = true;
          return Promise.resolve();
        },
        { root, waitMs: 1_000 },
      );
    } else rmSync(dirname(race.staged), { recursive: true });
    // Peer release has already happened; ENOENT cannot observe its lease anymore.
    expect(existsSync(updateLockPath("codex", root))).toBe(false);
    expect(existsSync(dirname(race.staged))).toBe(false);
    resume.resolve();
    if (peer) await expect(pending).resolves.toBeUndefined();
    else await expect(pending).resolves.toMatchObject({ errorCode: "update_not_started" });
    expect(await detectCodexCliCapabilities(directory)).toEqual({ supportsHookTrustBypass: !peer });
    expect(versions).toBe(peer ? 2 : 1);
    expect(helps).toBe(peer ? 2 : 1);
    expect(localUpdates).toBe(0);
    expect(peerUpdates).toBe(peer ? 1 : 0);
    expect(existsSync(join(root, "codex.completed"))).toBe(peer);
  } finally {
    resume.resolve();
    race.hold = false;
    await Promise.allSettled([pending]);
  }
});
