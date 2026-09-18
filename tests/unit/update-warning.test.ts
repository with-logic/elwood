/**
 * Unit coverage for the best-effort `agent_update_failed` warning builder (PRD §9.2, C-LIFE-11):
 * it extracts SAFE diagnostics from a contained update error and never leaks content.
 */

import { describe, expect, test } from "vitest";
import { elwoodError } from "../../src/core/errors.ts";
import { buildUpdateWarning } from "../../src/core/warnings/update.ts";
import { dedupeInFlight } from "../../src/runtime/update/once.ts";

describe("buildUpdateWarning", () => {
  test("carries the installed version, errno, and bounded stderr from an ElwoodError", () => {
    const error = elwoodError("claude_update_failed", "`claude update` failed.", {
      stderr: "boom",
      errno: "ETIMEDOUT",
    });
    expect(buildUpdateWarning("claude", "2.1.223", error)).toEqual({
      agent: "claude",
      source: "lifecycle",
      code: "agent_update_failed",
      severity: "warning",
      message: "`claude update` failed; continuing with the installed CLI 2.1.223.",
      installedVersion: "2.1.223",
      errorCode: "ETIMEDOUT",
      raw: "boom",
    });
  });

  test("falls back to a generic error code and empty stderr for a non-ElwoodError / no details", () => {
    const warning = buildUpdateWarning("codex", "0.132.0", new Error("plain failure"));
    expect(warning.errorCode).toBe("update_failed"); // no allowlisted errno available
    expect(warning.raw).toBe(""); // no stderr to surface
    expect(warning.installedVersion).toBe("0.132.0");
  });

  test("truncates an oversized stderr to keep the warning payload bounded", () => {
    const error = elwoodError("claude_update_failed", "failed", { stderr: "x".repeat(5000) });
    const warning = buildUpdateWarning("claude", "2.1.223", error);
    expect(warning.raw.length).toBeLessThanOrEqual(2000); // the 2 KB `maxStderr` cap
  });
});

describe("dedupeInFlight identity-guarded eviction", () => {
  test("a rejection does NOT evict a DIFFERENT (later, successful) entry for the same key", async () => {
    const cache = new Map<string, Promise<string>>();
    // Start a slow-rejecting entry, then REPLACE it under the same key with a resolved one BEFORE
    // the rejection settles. The rejection's eviction must be identity-guarded — it must not delete
    // the replacement (which is a different promise).
    let rejectFirst!: (e: unknown) => void;
    const first = dedupeInFlight(
      cache,
      "k",
      () =>
        new Promise<string>((_r, rej) => {
          rejectFirst = rej;
        }),
    );
    first.catch(() => undefined); // handle the expected rejection
    cache.set("k", Promise.resolve("winner")); // a later entry replaces the in-flight one
    rejectFirst(new Error("boom")); // now the first rejects — its eviction must be a no-op here
    await Promise.resolve();
    await Promise.resolve();
    await expect(cache.get("k")).resolves.toBe("winner"); // survived the identity-guarded eviction
  });
});

test("C-PERF-04 contention reports a skipped active updater rather than a failed local command", () => {
  const warning = buildUpdateWarning(
    "codex",
    "0.154.0",
    elwoodError("codex_update_failed", "internal", { updateReason: "active_owner" }),
  );
  expect(warning.errorCode).toBe("update_active");
  expect(warning.message).toBe(
    "`codex update` skipped: another updater is still active; continuing with the installed CLI 0.154.0.",
  );
  expect(warning.raw).toBe("");
});
