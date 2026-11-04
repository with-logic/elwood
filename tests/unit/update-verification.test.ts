/** A rejected pre-update verification neither completes nor caches an update (PRD §9.2, C-LIFE-09). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import {
  type CommandResult,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";
import { coordinatedAutoupdate } from "../../src/runtime/update/lock.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

beforeEach(() => {
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  setPlatformForTests("darwin");
});
for (const [agent, version, preflight] of [
  ["claude", "2.1.144", preflightClaude],
  ["codex", "codex-cli 0.150.0", preflightCodex],
] as const) {
  test(`C-LIFE-09 ${agent} retries after verification failed without running its updater`, async () => {
    const root = tempDir("elwood-update-verify-");
    setUpdateCoordinatorForTests((adapter, update) =>
      coordinatedAutoupdate(adapter, update, { root }),
    );
    let versions = 0;
    let updates = 0;
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes(`${agent} update`)) {
        updates += 1;
        return { status: 0, stdout: "", stderr: "" };
      }
      return ++versions === 1
        ? { status: 1, stdout: "", stderr: "verification refused" }
        : { status: 0, stdout: version, stderr: "" };
    });
    const first = await preflight(false, true);
    const completionAfterRefusal = existsSync(join(root, `${agent}.completed`));
    const second = await preflight(false, true);
    expect({ first: first?.code, second: second?.code, completionAfterRefusal, updates }).toEqual({
      first: "agent_update_failed",
      second: undefined,
      completionAfterRefusal: false,
      updates: 1,
    });
  });
}

for (const [agent, version, preflight] of [
  ["claude", "2.1.144", preflightClaude],
  ["codex", "codex-cli 0.150.0", preflightCodex],
] as const) {
  test(`C-LIFE-09 ${agent} persistent verification failures reject compatibility without updating`, async () => {
    setUpdateCoordinatorForTests((_adapter, update) => update());
    let updates = 0;
    setCommandRunnerForTests((_shell, args) => {
      if (args.join(" ").includes(`${agent} update`)) updates++;
      return { status: 1, stdout: "", stderr: "persistent prerequisite failure" };
    });
    await expect(preflight(false, true)).rejects.toMatchObject({ code: `${agent}_start_failed` });
    expect(updates).toBe(0);
  });

  test(`C-LIFE-09 ${agent} waiters share the next owner's update but check their own compatibility`, async () => {
    const root = tempDir("elwood-update-waiter-lease-");
    let owners = 0;
    setUpdateCoordinatorForTests((adapter, update) =>
      coordinatedAutoupdate(
        adapter,
        () => {
          owners++;
          return update();
        },
        { root },
      ),
    );
    const firstEntered = Promise.withResolvers<void>();
    const firstVersion = Promise.withResolvers<CommandResult>();
    const updateEntered = Promise.withResolvers<void>();
    const updater = Promise.withResolvers<CommandResult>();
    const owner = tempDir("elwood-refused-owner-");
    const good = tempDir("elwood-good-waiter-");
    const bad = tempDir("elwood-bad-waiter-");
    const events: string[] = [];
    setCommandRunnerForTests((_shell, args, options) => {
      const label = options?.cwd === owner ? "owner" : options?.cwd === good ? "good" : "bad";
      if (args.join(" ").includes(`${agent} update`)) {
        events.push(`${label}:update`);
        updateEntered.resolve();
        return updater.promise;
      }
      events.push(`${label}:version`);
      if (label === "owner" && events.length === 1) {
        firstEntered.resolve();
        return firstVersion.promise;
      }
      return { status: 0, stdout: label === "bad" ? "0.0.1" : version, stderr: "" };
    });
    const initial = preflight(false, true, { cwd: owner });
    await firstEntered.promise;
    const accepted = preflight(false, true, { cwd: good });
    const rejected = preflight(false, true, { cwd: bad });
    const settled = Promise.allSettled([initial, accepted, rejected]);
    firstVersion.resolve({ status: 1, stdout: "", stderr: "transient verification failure" });
    try {
      await updateEntered.promise;
      expect(events).not.toContain("bad:version");
      expect(events.indexOf("good:version")).toBeLessThan(events.indexOf("good:update"));
    } finally {
      updater.resolve({ status: 0, stdout: "", stderr: "" });
    }
    const [first, healthy, incompatible] = await settled;
    expect(first).toMatchObject({
      status: "fulfilled",
      value: { code: "agent_update_failed", errorCode: "update_not_started" },
    });
    expect(healthy).toEqual({ status: "fulfilled", value: undefined });
    expect(incompatible).toMatchObject({
      status: "rejected",
      reason: { code: `${agent}_version_unsupported` },
    });
    expect(events.filter((event) => event.endsWith(":update"))).toEqual(["good:update"]);
    expect(events.filter((event) => event === "bad:version")).toHaveLength(1);
    expect(owners).toBe(2);
  });
}
