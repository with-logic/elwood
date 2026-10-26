/**
 * The CLI's content-free cleanup diagnostic (PRD §12A.2, C-CLI-09): typed failures by
 * code and errno token only; never a message, path, or other free text.
 */

import { describe, expect, test } from "vitest";
import { cleanupFailureMessage } from "../../src/cli/output/cleanup-error.ts";
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
