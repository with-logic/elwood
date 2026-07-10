/**
 * Unit tests for startup error cause extraction.
 * Covers PRD §10 and C-ERR-08.
 */

import { describe, expect, test } from "vitest";
import { causeDetails, errnoCode } from "../../src/core/errors.ts";

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
