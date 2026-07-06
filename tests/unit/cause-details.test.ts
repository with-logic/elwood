/**
 * Unit tests for startup error cause extraction.
 * Covers PRD §10 and C-ERR-08.
 */

import { describe, expect, test } from "vitest";
import { causeDetails } from "../../src/core/errors.ts";

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
