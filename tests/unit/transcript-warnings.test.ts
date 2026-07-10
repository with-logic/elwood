/**
 * Focused coverage for the transcript diagnostic warning builders.
 * Covers PRD §5.4 (C-CLAUDE-15): content-free warnings from bounded notices.
 */

import { describe, expect, test } from "vitest";
import { pollErrorWarning } from "../../src/claude/transcript/warnings.ts";

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
});
