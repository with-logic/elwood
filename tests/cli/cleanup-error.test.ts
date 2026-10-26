/**
 * The CLI's content-free cleanup diagnostic (PRD §12A.2, C-CLI-09): typed failures by
 * code, errno tokens, and unconfirmed process-group ids only; never a message, path,
 * or other free text.
 */

import { describe, expect, test } from "vitest";
import { cleanupFailureMessage, textErrorLines } from "../../src/cli/output/cleanup-error.ts";
import type { CliCleanup, CliError } from "../../src/cli/output/types.ts";
import { elwoodError } from "../../src/core/errors.ts";

const reap = elwoodError("termination_failed", "secret /private/path", { errno: "EPERM" });

describe("C-CLI-09 cleanupFailureMessage", () => {
  test.each([
    ["an untyped failure", new Error("secret /private/path"), "Cleanup failed."],
    ["a typed failure with its errno", reap, "Cleanup failed (termination_failed EPERM)."],
    [
      "a typed failure without an errno",
      elwoodError("termination_failed", "PTY did not exit after SIGKILL."),
      "Cleanup failed (termination_failed).",
    ],
    [
      "an errno that is not an errno token",
      elwoodError("termination_failed", "x", { errno: "/private/path" }),
      "Cleanup failed (termination_failed).",
    ],
    [
      "a failure's path, apart from its errno",
      elwoodError("termination_failed", "x", { errno: "ENOENT", path: "/private/path" }),
      "Cleanup failed (termination_failed ENOENT).",
    ],
    [
      "an errno token at the 40-character suffix limit",
      elwoodError("termination_failed", "x", { errno: `E${"A".repeat(40)}` }),
      `Cleanup failed (termination_failed E${"A".repeat(40)}).`,
    ],
    [
      "an errno token past that limit",
      elwoodError("termination_failed", "x", { errno: `E${"A".repeat(41)}` }),
      "Cleanup failed (termination_failed).",
    ],
    [
      "a timed-out termination whose reap failed too",
      elwoodError("termination_failed", "PTY did not exit after SIGKILL.", {
        reapError: "secret",
        reapErrno: "EPERM",
      }),
      "Cleanup failed (termination_failed reap EPERM).",
    ],
    [
      "a failed PTY signal whose reap failed too",
      elwoodError("termination_failed", "x", { errno: "EIO", reapErrno: "EPERM" }),
      "Cleanup failed (termination_failed EIO reap EPERM).",
    ],
    [
      "a reap errno that is not an errno token",
      elwoodError("termination_failed", "x", { reapErrno: "/private/path" }),
      "Cleanup failed (termination_failed).",
    ],
    [
      "a sweep failure's unconfirmed process groups, after its errno",
      elwoodError("termination_failed", "x", {
        errno: "EAGAIN",
        unconfirmedProcessGroupIds: [4242, 4243],
      }),
      "Cleanup failed (termination_failed EAGAIN process groups 4242 4243).",
    ],
    [
      "process-group ids that are not positive integers",
      elwoodError("termination_failed", "x", {
        unconfirmedProcessGroupIds: [0, -1, 1.5, "4242", Number.MAX_SAFE_INTEGER + 1, 7],
      }),
      "Cleanup failed (termination_failed process groups 7).",
    ],
    [
      "unconfirmed process groups that are not a list",
      elwoodError("termination_failed", "x", { unconfirmedProcessGroupIds: "4242" }),
      "Cleanup failed (termination_failed).",
    ],
    [
      "more unconfirmed process groups than a sweep failure can name",
      elwoodError("termination_failed", "x", {
        unconfirmedProcessGroupIds: Array.from({ length: 20 }, (_, index) => index + 1),
      }),
      `Cleanup failed (termination_failed process groups ${Array.from({ length: 16 }, (_, index) => index + 1).join(" ")}).`,
    ],
    [
      "a teardown by its typed step failures",
      elwoodError("teardown_failed", "Could not fully tear down Elwood session.", {
        causes: ["secret /private/path", "bridge stop failed"],
        failures: [
          { message: "secret /private/path", code: "termination_failed", details: reap.details },
          { message: "bridge stop failed" },
        ],
      }),
      "Cleanup failed (termination_failed EPERM).",
    ],
    [
      "a teardown with two typed step failures, in step order",
      elwoodError("teardown_failed", "Could not fully tear down Elwood session.", {
        failures: [
          { message: "secret", code: "termination_failed", details: { errno: "EPERM" } },
          { message: "bridge stop failed" },
          { message: "secret", code: "teardown_failed", details: { errno: "EACCES" } },
        ],
      }),
      "Cleanup failed (termination_failed EPERM, teardown_failed EACCES).",
    ],
    [
      "a teardown whose steps all failed untyped",
      elwoodError("teardown_failed", "Could not fully tear down Elwood session.", {
        failures: [{ message: "bridge stop failed" }],
      }),
      "Cleanup failed.",
    ],
    [
      "a teardown_failed that lists no step failures",
      elwoodError("teardown_failed", "Could not remove Elwood session files.", { errno: "EACCES" }),
      "Cleanup failed (teardown_failed EACCES).",
    ],
  ])("%s", (_name, error, expected) => {
    expect(cleanupFailureMessage(error)).toBe(expected);
  });
});

function record(code: string, cleanup: CliCleanup): CliError {
  const base = { schemaVersion: 1, type: "error", agent: "codex", response: "" } as const;
  return {
    ...base,
    sessionId: null,
    durationMs: 0,
    cleanup,
    error: { code, message: "Timed out." },
  };
}

describe("C-CLI-09 textErrorLines", () => {
  const failed = { action: "teardown", status: "failed", error: "Cleanup failed." } as const;
  const upper = (text: string) => text.toUpperCase();

  test("a failed cleanup behind a different primary failure gets its own line", () => {
    expect(textErrorLines(record("timeout", failed), "elwood: ", upper)).toBe(
      "elwood: TIMED OUT.\nelwood: CLEANUP FAILED.\n",
    );
  });

  test.each([
    ["a cleanup failure that is the primary failure", record("cleanup_failed", failed)],
    ["a cleanup that succeeded", record("timeout", { action: "teardown", status: "succeeded" })],
  ])("%s is the error's line alone", (_name, value) => {
    expect(textErrorLines(value, "elwood: ", upper)).toBe("elwood: TIMED OUT.\n");
  });
});
