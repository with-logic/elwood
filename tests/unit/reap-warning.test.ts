/**
 * Focused coverage for the reap-failure warning builder's error-code allowlist.
 * Covers PRD §5.7 (C-LIFE-10): a `reap_failed` warning carries ONLY an allowlisted
 * normalized error code + the leaked pgid — never a raw system message, an
 * arbitrary `Error.name`/`.code`, or a stringified non-Error cause.
 */

import { describe, expect, test } from "vitest";
import { reapFailureWarning } from "../../src/core/activity.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";

/** Narrow to the `reap_failed` member so its bounded fields are readable. */
function reap(error: unknown, pgid = 4242): Extract<ElwoodWarningEvent, { code: "reap_failed" }> {
  const warning = reapFailureWarning("claude", "elwood-9", pgid, error);
  if (warning.code !== "reap_failed") throw new Error("wrong warning code");
  return warning;
}

describe("C-LIFE-10 reapFailureWarning error-code allowlist", () => {
  test("normalizes an allowlisted errno / error name; the pgid is preserved", () => {
    const eperm = reap(Object.assign(new Error("permission denied"), { code: "EPERM" }));
    expect(eperm).toMatchObject({ code: "reap_failed", errorCode: "EPERM", processGroupId: 4242 });
    expect(eperm.message).toContain("EPERM");
    expect(eperm.message).toContain("4242");
    // A plain Error without an errno normalizes to its allowlisted constructor name.
    expect(reap(new TypeError("bad state")).errorCode).toBe("TypeError");
  });

  test("never leaks a secret from message, arbitrary name, arbitrary code, or a non-Error", () => {
    const secret = "hunter2-SECRET-token";
    // A message that embeds a secret must NOT reach any field: only the bounded
    // allowlisted name/errno does.
    const leakyMessage = new Error(`env leak: ${secret}`);
    // A caller-controlled `.name` that embeds a secret is NOT on the allowlist, so
    // it collapses to the fixed token.
    const leakyName = Object.assign(new Error("x"), { name: secret });
    // A caller-controlled `.code` that embeds a secret is NOT on the allowlist, so
    // it falls back to the (allowlisted) constructor name, never the code.
    const leakyCode = Object.assign(new Error("y"), { code: secret });
    // A non-Error cause is NOT stringified into a field: it collapses to the token.
    for (const [error, expected] of [
      [leakyMessage, "Error"],
      [leakyName, "UnknownError"],
      [leakyCode, "Error"],
      [`raw ${secret}`, "UnknownError"],
      [Object.assign(new Error("z"), { name: secret, code: secret }), "UnknownError"],
    ] as const) {
      const warning = reap(error);
      expect(warning.errorCode).toBe(expected);
      // The secret appears in NO field of the warning.
      for (const field of Object.values(warning)) {
        expect(String(field)).not.toContain(secret);
      }
    }
  });

  test("a NEW leaked process group carries its own pgid on a distinct live warning", () => {
    // Each reap failure is its own live warning; a resumed session's NEW PTY leader
    // leaks a different group, surfaced as a distinct warning carrying that pgid.
    const eperm = Object.assign(new Error("x"), { code: "EPERM" });
    expect(reap(eperm, 4242).processGroupId).toBe(4242);
    expect(reap(eperm, 9001).processGroupId).toBe(9001);
  });
});
