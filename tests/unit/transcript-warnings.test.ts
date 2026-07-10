/**
 * Focused coverage for the transcript diagnostic warning builders.
 * Covers PRD §5.4 (C-CLAUDE-15): content-free warnings from bounded notices.
 */

import { describe, expect, test } from "vitest";
import type { DropCause } from "../../src/claude/transcript/drops.ts";
import { dropWarning, pollErrorWarning } from "../../src/claude/transcript/warnings.ts";

/** The `transcript_poll_stopped` member carries `reason`; narrow to read it. */
function reasonOf(error: unknown): string {
  const warning = pollErrorWarning("s1", error);
  if (warning.code !== "transcript_poll_stopped") throw new Error("wrong warning code");
  return warning.reason;
}

describe("C-CLAUDE-15 transcript warning builders", () => {
  test("pollErrorWarning persists only a bounded error name, never the message", () => {
    // The escaping error can be a downstream listener exception whose message
    // embeds raw transcript content; that message must NOT reach persisted
    // fields. Only the bounded error name/errno does.
    const leaky = new Error("secret prompt: my password is hunter2");
    const warning = pollErrorWarning("s1", leaky);
    expect(warning).toMatchObject({ code: "transcript_poll_stopped", reason: "Error" });
    expect(warning.message).toBe("Transcript polling stopped after an unexpected error.");
    for (const field of [warning.message, reasonOf(leaky), String(warning.raw)]) {
      expect(field).not.toContain("hunter2");
      expect(field).not.toContain("secret prompt");
    }
  });

  test("pollErrorWarning maps only ALLOWLISTED names/errnos, else UnknownError", () => {
    // A filesystem error surfaces an allowlisted errno; a standard error
    // constructor name is allowlisted.
    const enoent = Object.assign(new Error("open failed"), { code: "ENOENT" });
    expect(reasonOf(enoent)).toBe("ENOENT");
    expect(reasonOf(new TypeError("boom"))).toBe("TypeError");
    // A caller-controlled name/code that is NOT on the allowlist — even a
    // plausible-looking identifier — collapses to the fixed token, so no
    // conversation-derived string can reach persisted state.
    const exotic = new Error("x");
    exotic.name = "secretPasswordHunter2";
    expect(reasonOf(exotic)).toBe("UnknownError");
    // A non-allowlisted code falls back to the (allowlisted) constructor name,
    // never the caller-controlled code string — so "leakedPromptText" is dropped.
    const spoofCode = Object.assign(new Error("y"), { code: "leakedPromptText" });
    expect(reasonOf(spoofCode)).toBe("Error");
    // Non-allowlisted code AND non-allowlisted name → the fixed token.
    const spoofBoth = Object.assign(new Error("z"), { code: "leakA" });
    spoofBoth.name = "leakB";
    expect(reasonOf(spoofBoth)).toBe("UnknownError");
    // A non-Error cause with no code falls back to the fixed token.
    expect(reasonOf("raw-reason")).toBe("UnknownError");
  });

  test("pollErrorWarning carries the phase and a phase-specific message", () => {
    // MAJOR: the same warning code distinguishes a live poll failure from a failed
    // final flush at exit via the bounded `phase` field, so an operator can tell
    // lost trailing shutdown activity from a live-watcher poll failure.
    const poll = pollErrorWarning("s1", new Error("x")); // defaults to "poll"
    if (poll.code !== "transcript_poll_stopped") throw new Error("wrong code");
    expect(poll.phase).toBe("poll");
    expect(poll.message).toContain("polling stopped");
    expect(poll.raw).toContain("phase=poll");
    const flush = pollErrorWarning("s1", new Error("x"), "final_flush");
    if (flush.code !== "transcript_poll_stopped") throw new Error("wrong code");
    expect(flush.phase).toBe("final_flush");
    expect(flush.message).toContain("final flush");
    expect(flush.raw).toContain("phase=final_flush");
  });

  test("dropWarning labels every cause truthfully and never carries content", () => {
    // MAJOR: unparseable, oversized, and unread-backlog losses share ONE code but
    // carry a bounded `cause` discriminator, so a valid unread backlog is never
    // mislabelled as an unparseable record. The count/bytes are magnitudes only.
    const cases: Record<DropCause, string> = {
      unparseable: "unparseable",
      oversized: "over-length",
      unread_backlog: "unread transcript backlog",
    };
    for (const cause of Object.keys(cases) as DropCause[]) {
      const warning = dropWarning({
        elwoodSessionId: "s1",
        path: "/tmp/t.jsonl",
        droppedCount: 2,
        droppedBytes: 4096,
        cause,
      });
      if (warning.code !== "transcript_records_dropped") throw new Error("wrong code");
      expect(warning.cause).toBe(cause);
      expect(warning.message).toContain(cases[cause]);
      expect(warning.raw).toContain(`cause=${cause}`);
      expect(warning.droppedCount).toBe(2);
      expect(warning.droppedBytes).toBe(4096);
    }
  });
});
