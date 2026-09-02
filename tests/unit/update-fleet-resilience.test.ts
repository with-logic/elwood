/**
 * Fleet-startup resilience for best-effort autoupdate and cached probes (PRD §9.2, C-LIFE-09/11).
 * A failed shared update must be shared ONCE, reject NO concurrent caller, and never poison a
 * later start. Cached probes (version read, capability detection) must not retain a rejected
 * result. These are the acceptance cases Coal Harbor requested after the fleet-startup failure.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import {
  detectCodexCliCapabilities,
  resetCodexPreflightCacheForTests,
} from "../../src/codex/preflight.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";
import {
  cachedAutoupdate,
  cachedVersionRead,
  dedupeInFlight,
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update-once.ts";

function resetPreflight(): void {
  resetAutoupdateForTests();
  setUpdateCoordinatorForTests((_adapter, update) => update());
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
}

describe("autoupdate fleet resilience (C-LIFE-09/11)", () => {
  beforeEach(() => {
    resetPreflight();
    setPlatformForTests("darwin");
  });

  test("N concurrent starts + ONE failed update → one update attempt, N usable sessions", async () => {
    let updates = 0;
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("claude update")) {
        updates += 1; // count the shared update attempts
        return { status: 1, stdout: "", stderr: "network error" };
      }
      return { status: 0, stdout: "2.1.223", stderr: "" }; // installed >= min
    });
    // 10 concurrent roster starts share the SINGLE update; none rejects (all compatible).
    const warnings = await Promise.all(
      Array.from({ length: 10 }, () => preflightClaude(false, true)),
    );
    expect(updates).toBe(1); // one shared update attempt across the whole burst
    // Every start is usable and observes the SAME best-effort outcome (a warning, not a rejection).
    for (const w of warnings) expect(w).toMatchObject({ code: "agent_update_failed" });
    resetRuntimeSeamsForTests();
  });

  test("a LATER start after a failed shared update is not stuck on a retained rejected promise", async () => {
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("claude update")
        ? { status: 1, stdout: "", stderr: "failed" }
        : { status: 0, stdout: "2.1.223", stderr: "" },
    );
    // First start: update fails but installed is compatible → warns and continues.
    await expect(preflightClaude(false, true)).resolves.toMatchObject({
      code: "agent_update_failed",
    });
    // A LATER start in the SAME process must also succeed (best-effort once-per-process), NOT
    // reject on a retained rejected promise. It does not re-run the update (dedup holds).
    await expect(preflightClaude(false, true)).resolves.toMatchObject({
      code: "agent_update_failed",
    });
    resetRuntimeSeamsForTests();
  });

  test("cachedVersionRead evicts a rejected read so a later caller retries (no poison)", async () => {
    let attempt = 0;
    const read = () => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("transient runner failure"))
        : Promise.resolve({ status: 0, stdout: "ok", stderr: "" });
    };
    await expect(cachedVersionRead("claude", read)).rejects.toThrow(/transient/);
    // The rejection was evicted; the next caller re-attempts and succeeds.
    await expect(cachedVersionRead("claude", read)).resolves.toMatchObject({ stdout: "ok" });
    expect(attempt).toBe(2); // it genuinely retried, not replayed the corpse
    resetPreflight();
  });

  test("detectCodexCliCapabilities does not poison later starts after a failed `codex --help`", async () => {
    let helps = 0;
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("--help")) {
        helps += 1;
        return helps === 1
          ? { status: 1, stdout: "", stderr: "help boom" } // first probe fails
          : { status: 0, stdout: "--dangerously-bypass-hook-trust", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    await expect(detectCodexCliCapabilities()).rejects.toMatchObject({
      code: "codex_start_failed",
    });
    // A later start re-probes (the rejected capability promise was evicted), and recovers.
    await expect(detectCodexCliCapabilities()).resolves.toEqual({ supportsHookTrustBypass: true });
    resetRuntimeSeamsForTests();
  });

  test("dedupeInFlight: identity-guarded eviction never clobbers a later successful entry", async () => {
    const cache = new Map<string, Promise<string>>();
    // A rejecting call is cached then evicted on rejection.
    const failing = dedupeInFlight(cache, "k", () => Promise.reject(new Error("boom")));
    await expect(failing).rejects.toThrow(/boom/);
    // A subsequent successful call caches its own entry; the earlier eviction must not delete it.
    const ok = dedupeInFlight(cache, "k", () => Promise.resolve("value"));
    await expect(ok).resolves.toBe("value");
    expect(cache.get("k")).toBe(ok); // the successful entry survives (identity-guarded eviction)
  });

  test("autoupdate finalization failures are contained as outcomes", async () => {
    await expect(
      cachedAutoupdate(
        "codex",
        () => Promise.resolve(),
        () => {
          throw new Error("cache invalidation failed");
        },
      ),
    ).resolves.toMatchObject({ ok: false, error: new Error("cache invalidation failed") });
  });
});
