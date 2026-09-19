/**
 * Coverage that a DRIFTED Claude `StopFailure` survives INGRESS and is still classified as a
 * turn failure (PRD §12A.5, C-API-57).
 *
 * The fourth variant of this feature's bug class, and the one that proves the general rule:
 * shape-independence must hold along the WHOLE path from ingress to classification. Production
 * ingress (`isClaudeHookInput`, wired into the hook bridge) once required a string `error`, so a
 * missing or restructured payload became a `hookError` and the rejection settled as an empty
 * success — the reader's tolerant fallback was unreachable. A tolerant reader sitting behind a
 * strict validator is tolerant in name only.
 *
 * These assert ingress AND classification together, because a reader-only test passes either
 * way — which is exactly how this hid.
 */

import { describe, expect, test } from "vitest";
import { claudeBoundarySignal } from "../../src/claude/turn-failure.ts";
import { isClaudeHookInput } from "../../src/claude/validate/input.ts";
import { boundaryFailure } from "../../src/core/simple/turn-types.ts";

describe("C-API-57 a drifted StopFailure survives INGRESS and still fails the turn", () => {
  // The fourth variant of this PR's bug class, and the most instructive: the first three lost
  // the evidence inside the reader, this one lost it BEFORE the reader. Production ingress
  // (`isClaudeHookInput`, wired into the hook bridge) used to require a string `error`, so a
  // missing or restructured payload became a `hookError` and the rejection settled as an empty
  // success — the reader's tolerant fallback was unreachable. Shape-independence has to hold
  // along the WHOLE path: a tolerant reader behind a strict validator is tolerant in name only.
  //
  // These assert INGRESS → CLASSIFICATION together. A reader-only test passes either way, which
  // is exactly how this hid.
  test.each([
    ["a missing error", {}],
    ["a non-string error", { error: { code: "rate_limit" } }],
    ["a null error", { error: null }],
    // BOTH validation gates must be loose, not just the first: `event-fields.ts` used to
    // reject a drifted `error_details`/`last_assistant_message` after `input.ts` admitted the
    // event, which put the rejection back on the `hookError` path.
    ["a non-string error_details", { error_details: { text: "nope" } }],
    ["a non-string last_assistant_message", { last_assistant_message: 7 }],
  ])("%s is admitted and classified as turn_failed", (_label, extra) => {
    const event = { hook_event_name: "StopFailure", session_id: "s1", cwd: "/tmp", ...extra };
    // 1. INGRESS must admit it — otherwise it never reaches the reader at all.
    expect(isClaudeHookInput(event)).toBe(true);
    // 2. CLASSIFICATION must then call it a failure, with the bounded generic reason.
    const failure = boundaryFailure(claudeBoundarySignal(event) ?? "");
    expect(failure?.message).toBe("Claude rejected the turn.");
  });

  test("a well-formed StopFailure still names its error, and other hooks stay STRICT", () => {
    const good = {
      hook_event_name: "StopFailure",
      session_id: "s1",
      cwd: "/tmp",
      error: "rate_limit",
    };
    expect(isClaudeHookInput(good)).toBe(true);
    expect(boundaryFailure(claudeBoundarySignal(good) ?? "")?.info).toBe("rate_limit");
    // Loosening is scoped to the REJECTION event: the table is the validation boundary for
    // untrusted hook input, so a different hook with a missing required field is still rejected.
    expect(
      isClaudeHookInput({ hook_event_name: "Notification", session_id: "s1", cwd: "/tmp" }),
    ).toBe(false);
  });
});
