/**
 * Focused coverage for the shared bounded-error-token helper that every
 * content-free warning (reap, transcript poll, resize restore) uses to normalize
 * an arbitrary thrown value to an allowlisted token. Covers PRD §5.7: an error's
 * `.code`, `Error.name`, and message are system/caller-controlled, so only a value
 * the supplied guard accepts survives — everything else, including a raw system
 * message that could embed a secret, collapses to `UnknownError`.
 */

import { describe, expect, test } from "vitest";
import {
  boundedErrorToken,
  isResizeErrorCode,
  unknownErrorToken,
} from "../../src/core/warnings/reasons.ts";

describe("boundedErrorToken", () => {
  test("prefers an allowlisted `.code` (errno) over the error name", () => {
    const error = Object.assign(new TypeError("boom"), { code: "EIO" });
    // `.code` wins even though `TypeError` is also allowlisted.
    expect(boundedErrorToken(error, isResizeErrorCode)).toBe("EIO");
  });

  test("falls back to an allowlisted Error.name when `.code` is absent or off-allowlist", () => {
    expect(boundedErrorToken(new TypeError("bad"), isResizeErrorCode)).toBe("TypeError");
    const offAllowlistCode = Object.assign(new RangeError("r"), { code: "NOT_ALLOWED" });
    expect(boundedErrorToken(offAllowlistCode, isResizeErrorCode)).toBe("RangeError");
  });

  test("collapses any non-allowlisted value — including a raw string — to UnknownError", () => {
    const secret = "hunter2-SECRET";
    for (const error of [
      `raw ${secret}`,
      null,
      undefined,
      Object.assign(new Error("x"), { name: secret }),
    ]) {
      const token = boundedErrorToken(error, isResizeErrorCode);
      expect(token).toBe(unknownErrorToken);
      expect(token).not.toContain(secret);
    }
  });
});
