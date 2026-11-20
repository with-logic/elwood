/**
 * Version-read cache and async-non-blocking preflight tests.
 * Covers PRD §9.2 and C-PERF-01, C-PERF-02.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import type { UpdateAdapter } from "../../src/runtime/update/lock.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";

function resetPreflight(): void {
  resetAutoupdateForTests();
  setUpdateCoordinatorForTests((_adapter, update) => update());
  resetPreflightCacheForTests();
}

describe("version-read cache", () => {
  beforeEach(resetPreflight);

  test("C-PERF-01 concurrent adapter preflights overlap instead of serializing", async () => {
    setPlatformForTests("darwin");
    // Keep the first read pending until the other adapter reaches its runner.
    const versions: Record<UpdateAdapter, string> = {
      claude: "2.1.144",
      codex: "codex-cli 0.132.0",
    };
    const started = new Set<UpdateAdapter>();
    const bothStarted = Promise.withResolvers<void>();
    setCommandRunnerForTests(async (_command, args) => {
      const agent = /\b(\w+) --version\b/u.exec(args.join(" "))?.[1];
      if (agent !== "claude" && agent !== "codex") {
        throw new Error("Expected a Claude or Codex version probe");
      }
      started.add(agent);
      if (started.size === 2) bothStarted.resolve();
      await bothStarted.promise;
      return { status: 0, stdout: versions[agent], stderr: "" };
    });
    await Promise.all([preflightClaude(false), preflightCodex(false)]);
    expect(started).toEqual(new Set(["claude", "codex"]));
  });

  test("C-PERF-02 reuses a retained --version result in the same directory", async () => {
    let reads = 0;
    setPlatformForTests("darwin");
    setCommandRunnerForTests(() => {
      reads += 1;
      return { status: 0, stdout: "2.1.144", stderr: "" };
    });
    await preflightClaude(false);
    await preflightClaude(true);
    expect(reads).toBe(1);
  });

  test("C-PERF-02 concurrent first reads share one subprocess", async () => {
    let reads = 0;
    setPlatformForTests("darwin");
    setCommandRunnerForTests(
      () =>
        new Promise((resolve) => {
          reads += 1;
          setTimeout(() => resolve({ status: 0, stdout: "2.1.144", stderr: "" }), 5);
        }),
    );
    await Promise.all([preflightClaude(false), preflightClaude(false), preflightClaude(false)]);
    expect(reads).toBe(1);
  });

  test("C-PERF-02 autoupdate invalidates the cache so the version is re-read", async () => {
    const versions: string[] = [];
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("claude update")) return { status: 0, stdout: "", stderr: "" };
      versions.push("read");
      return { status: 0, stdout: "2.1.144", stderr: "" };
    });
    await preflightClaude(false, true);
    // One read before the update, one after the invalidate.
    expect(versions).toHaveLength(2);
  });
});

describe("autoupdate dedupe", () => {
  beforeEach(resetPreflight);

  test("C-LIFE-09 autoupdate runs at most once per adapter per process", async () => {
    const commands: string[] = [];
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      commands.push(args.join(" "));
      return { status: 0, stdout: "2.1.144", stderr: "" };
    });
    await preflightClaude(false, true);
    await preflightClaude(false, true);
    await preflightCodex(false, true);
    await preflightCodex(false, true);
    const updates = commands.filter((command) => command.includes(" update"));
    expect(updates.filter((command) => command.includes("claude update"))).toHaveLength(1);
    expect(updates.filter((command) => command.includes("codex update"))).toHaveLength(1);
  });

  test("C-PERF-04 concurrent Claude autoupdate callers all validate the post-update version", async () => {
    // Version reads: the first (pre-update) is too old; after the shared
    // update the re-read is valid. Every concurrent caller must observe the
    // post-update version, not the stale pre-update one.
    const versions = ["2.1.1", "2.1.144", "2.1.144"];
    let updates = 0;
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("claude update")) {
        updates += 1;
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: versions.shift() ?? "2.1.144", stderr: "" };
    });
    // Three concurrent autoupdate callers: one update, all resolve (none
    // rejects on the stale 2.1.1 pre-update read).
    await Promise.all([
      preflightClaude(false, true),
      preflightClaude(false, true),
      preflightClaude(false, true),
    ]);
    expect(updates).toBe(1);
  });

  test("C-PERF-04 concurrent Codex autoupdate callers all validate the post-update version", async () => {
    const versions = ["codex-cli 0.1.0", "codex-cli 0.132.0", "codex-cli 0.132.0"];
    let updates = 0;
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      const joined = args.join(" ");
      if (joined.includes("codex update")) {
        updates += 1;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (joined.includes("--help")) return { status: 0, stdout: "codex help", stderr: "" };
      return { status: 0, stdout: versions.shift() ?? "codex-cli 0.132.0", stderr: "" };
    });
    await Promise.all([
      preflightCodex(false, true),
      preflightCodex(false, true),
      preflightCodex(false, true),
    ]);
    expect(updates).toBe(1);
  });

  test("C-PERF-04 concurrent autoupdate callers share ONE update failure without rejecting (C-LIFE-11)", async () => {
    let updates = 0;
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("claude update")) {
        updates += 1;
        return { status: 1, stdout: "", stderr: "failed" };
      }
      return { status: 0, stdout: "2.1.144", stderr: "" }; // installed == min → compatible
    });
    const results = await Promise.allSettled([
      preflightClaude(false, true),
      preflightClaude(false, true),
    ]);
    // Best-effort: the shared update fails ONCE, but neither caller rejects — both warn and
    // continue (the installed CLI meets the minimum). This is the fleet-death regression fixed.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    for (const r of results) {
      if (r.status === "fulfilled") expect(r.value).toMatchObject({ code: "agent_update_failed" });
    }
    expect(updates).toBe(1); // still exactly one shared update attempt
  });
});
