/**
 * Focused coverage for the resize-restore-failure warning builder. Covers PRD
 * §5.3/§5.7 (C-API-39): a `resize_restore_failed` warning carries ONLY an allowlisted
 * normalized error code + the requested size — never a raw system message or an
 * arbitrary `Error.name`/`.code`. Live-only (never persisted).
 */

import { describe, expect, test } from "vitest";
import { resizeRestoreFailedWarning } from "../../src/claude/resize-restore.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";

const id = "resize-target";

function build(error: unknown): Extract<ElwoodWarningEvent, { code: "resize_restore_failed" }> {
  const warning = resizeRestoreFailedWarning(id, { cols: 68, rows: 10 }, error);
  if (warning.code !== "resize_restore_failed") throw new Error("wrong warning code");
  return warning;
}

describe("C-API-39 resizeRestoreFailedWarning error-code allowlist", () => {
  test("normalizes an allowlisted errno / error name; the requested size is preserved", () => {
    const eio = build(Object.assign(new Error("io error"), { code: "EIO" }));
    expect(eio).toMatchObject({ errorCode: "EIO", requestedCols: 68, requestedRows: 10 });
    expect(eio.message).toContain("EIO");
    expect(eio.message).toContain("68x10");
    // A plain Error without an errno normalizes to its allowlisted constructor name.
    expect(build(new TypeError("bad size")).errorCode).toBe("TypeError");
  });

  test("never leaks a secret from message, arbitrary name/code, or a non-Error cause", () => {
    const secret = "hunter2-SECRET-token";
    for (const [error, expected] of [
      [new Error(`env leak: ${secret}`), "Error"],
      [Object.assign(new Error("x"), { name: secret }), "UnknownError"],
      [Object.assign(new Error("y"), { code: secret }), "Error"],
      [`raw ${secret}`, "UnknownError"],
    ] as const) {
      const warning = build(error);
      expect(warning.errorCode).toBe(expected);
      for (const field of Object.values(warning)) {
        expect(String(field)).not.toContain(secret);
      }
    }
  });
});
