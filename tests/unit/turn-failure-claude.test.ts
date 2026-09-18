/**
 * Unit coverage for CLAUDE's turn-rejection evidence (PRD §12A.5, C-API-57). Claude's
 * `StopFailure` IS a turn-boundary hook, so — unlike Codex, whose evidence is transcript-only
 * (`turn-failure.test.ts`) — its failure rides the boundary signal itself.
 */

import { describe, expect, test } from "vitest";
import { claudeBoundarySignal } from "../../src/claude/turn-failure.ts";
import { boundaryFailure, boundaryText } from "../../src/core/simple/turn-types.ts";

describe("C-API-57 Claude reports a rejected turn on its StopFailure boundary", () => {
  test("StopFailure carries the failure on the same boundary", () => {
    const signal = claudeBoundarySignal({
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_details: "You have exceeded your rate limit.",
    });
    // A boundary either way — with no completed assistant text — now reporting WHY.
    expect(boundaryText(signal ?? "")).toBe("");
    expect(boundaryFailure(signal ?? "")).toEqual({
      message: "You have exceeded your rate limit.",
      info: "rate_limit",
    });
  });

  test("a StopFailure without details still names its error, and an unnamed one is truthful", () => {
    expect(
      boundaryFailure(
        claudeBoundarySignal({ hook_event_name: "StopFailure", error: "billing_error" }) ?? "",
      ),
    ).toEqual({ message: "Claude rejected the turn: billing_error", info: "billing_error" });
    expect(boundaryFailure(claudeBoundarySignal({ hook_event_name: "StopFailure" }) ?? "")).toEqual(
      {
        message: "Claude rejected the turn.",
      },
    );
  });

  test("a BLANK error_details falls back to the error instead of a blank message", () => {
    // An empty/whitespace detail must not be authoritative: it would erase the usable reason and
    // surface a blank `turn_failed` message to library and CLI consumers.
    for (const error_details of ["", "   ", "\n\t "]) {
      expect(
        boundaryFailure(
          claudeBoundarySignal({
            hook_event_name: "StopFailure",
            error: "billing_error",
            error_details,
          }) ?? "",
        ),
      ).toEqual({ message: "Claude rejected the turn: billing_error", info: "billing_error" });
    }
    // With neither a usable detail nor a usable error, the reason is still truthful.
    expect(
      boundaryFailure(claudeBoundarySignal({ hook_event_name: "StopFailure", error: "  " }) ?? ""),
    ).toEqual({ message: "Claude rejected the turn." });
  });

  test("an oversized error is bounded BEFORE it is interpolated into the reason", () => {
    // Bounding after interpolation would retain the whole multi-megabyte payload.
    const failure = boundaryFailure(
      claudeBoundarySignal({ hook_event_name: "StopFailure", error: "z".repeat(5_000) }) ?? "",
    );
    expect(failure?.info).toHaveLength(2_001); // 2000 chars + ellipsis
    expect(failure?.message).toHaveLength("Claude rejected the turn: ".length + 2_001);
  });

  test("an oversized error detail is bounded", () => {
    const signal = claudeBoundarySignal({
      hook_event_name: "StopFailure",
      error: "server_error",
      error_details: "y".repeat(5_000),
    });
    expect(boundaryFailure(signal ?? "")?.message).toHaveLength(2_001);
  });

  test("§12A.3 an ordinary Stop is unchanged — an EMPTY reply is still a success", () => {
    // The default boundary behaviour must survive: `Stop` with no text is a quiet settle, and
    // carries no failure, so a legitimately empty turn still succeeds.
    const empty = claudeBoundarySignal({ hook_event_name: "Stop", last_assistant_message: null });
    expect(empty).toBe("");
    expect(boundaryFailure(empty ?? "")).toBeUndefined();
    expect(claudeBoundarySignal({ hook_event_name: "Stop", last_assistant_message: "HI" })).toBe(
      "HI",
    );
    // A non-boundary hook is still not a boundary.
    expect(claudeBoundarySignal({ hook_event_name: "Notification" })).toBeUndefined();
  });
});
