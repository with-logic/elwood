/**
 * Unit tests for startup error cause extraction.
 * Covers PRD §10 and C-ERR-08.
 */

import { describe, expect, test } from "vitest";
import { causeDetails, errnoCode, probeFailureDetails } from "../../src/core/errors.ts";

describe("causeDetails", () => {
  test("C-ERR-08 stringifies non-Error failures", () => {
    expect(causeDetails("raw failure")).toEqual({ cause: "raw failure" });
  });

  test("C-ERR-08 plain errors carry only the cause", () => {
    expect(causeDetails(new Error("boom"))).toEqual({ cause: "boom" });
  });

  test("C-ERR-08 errno errors expose errno, syscall, and path", () => {
    const error = new Error("bind EINVAL") as NodeJS.ErrnoException;
    error.code = "EINVAL";
    error.syscall = "bind";
    error.path = "/very/long/hook.sock";
    expect(causeDetails(error)).toEqual({
      cause: "bind EINVAL",
      errno: "EINVAL",
      syscall: "bind",
      path: "/very/long/hook.sock",
    });
  });
});

describe("errnoCode", () => {
  test("C-ERR-01 reads a string .code off an errno error", () => {
    expect(errnoCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("ENOENT");
    expect(errnoCode({ code: "EPERM" })).toBe("EPERM");
  });

  test("C-ERR-01 returns undefined for null/undefined/primitive/no-code without throwing", () => {
    // Narrowing object-ness FIRST means a thrown null/primitive can never make the
    // inspection itself throw a secondary TypeError that would mask the original.
    expect(errnoCode(null)).toBeUndefined();
    expect(errnoCode(undefined)).toBeUndefined();
    expect(errnoCode("boom")).toBeUndefined();
    expect(errnoCode(42)).toBeUndefined();
    expect(errnoCode({ code: 500 })).toBeUndefined(); // non-string code
    expect(errnoCode({})).toBeUndefined();
  });
});

describe("probeFailureDetails", () => {
  const failed = (error: Record<string, unknown>) =>
    probeFailureDetails({ stderr: "boom", error: error as never });

  test("C-PERF-03 omits cleanup fields when the probe reported no cleanup", () => {
    expect(failed({ message: "spawn failed", code: "ENOENT" })).toEqual({
      stderr: "boom",
      cause: "spawn failed",
      errno: "ENOENT",
    });
  });

  // An unconfirmed cleanup carries BOTH: the code says why it is unconfirmed, and the
  // group id says which group is still unaccounted for. The id is diagnostic only — it
  // may already name an unrelated group, so nothing may signal it (PRD §9.2).
  test("C-PERF-03 surfaces the cleanup code and the unresolved process group", () => {
    expect(
      failed({ message: "aborted", cleanupErrorCode: "ETIMEDOUT", cleanupProcessGroupId: 4321 }),
    ).toEqual({
      stderr: "boom",
      cause: "aborted",
      cleanupErrorCode: "ETIMEDOUT",
      cleanupProcessGroupId: 4321,
    });
  });

  test("C-PERF-03 carries each cleanup field independently", () => {
    expect(failed({ message: "aborted", cleanupErrorCode: "EPERM" })).toEqual({
      stderr: "boom",
      cause: "aborted",
      cleanupErrorCode: "EPERM",
    });
    expect(failed({ message: "aborted", cleanupProcessGroupId: 99 })).toEqual({
      stderr: "boom",
      cause: "aborted",
      cleanupProcessGroupId: 99,
    });
  });
});
