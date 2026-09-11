/** Environment/value resolution branches. Covers PRD C-CLI-06/C-CLI-14. */

import { describe, expect, test } from "vitest";
import {
  choice,
  decodeEnvironment,
  nonBlank,
  optional,
  reasoning,
} from "../../src/cli/request/values.ts";

describe("CLI request values", () => {
  test("C-CLI-14 decodes every supported environment variable", () => {
    expect(
      decodeEnvironment({
        ELWOOD_AGENT: "claude",
        ELWOOD_OUTPUT: "json",
        ELWOOD_TIMEOUT: "1s",
        ELWOOD_TRUST: "false",
        ELWOOD_STATE_DIR: "state",
        ELWOOD_VERBOSE: "true",
        ELWOOD_STREAM: "false",
        ELWOOD_PERSONA: "p",
        ELWOOD_MODEL: "m",
        ELWOOD_REASONING_EFFORT: "high",
        ELWOOD_CLAUDE_PERMISSION_MODE: "plan",
        ELWOOD_CODEX_SANDBOX: "read-only",
        ELWOOD_CODEX_APPROVAL_POLICY: "on-request",
      }),
    ).toEqual({
      agent: "claude",
      output: "json",
      timeout: "1s",
      trust: false,
      stateDir: "state",
      verbose: true,
      stream: false,
      persona: "p",
      model: "m",
      reasoningEffort: "high",
      claudePermissionMode: "plan",
      codexSandbox: "read-only",
      codexApprovalPolicy: "on-request",
    });
  });

  test.each([
    [{ ELWOOD_TRUST: "yes" }, /true or false/iu],
    [{ ELWOOD_AGENT: "gemini" }, /one of/iu],
    [{ ELWOOD_MODEL: " " }, /empty/iu],
  ])("C-CLI-14 rejects invalid environment %#", (env, message) => {
    expect(() => decodeEnvironment(env)).toThrow(message);
  });

  test("covers precedence and optional helpers", () => {
    expect(choice("a", ["a", "b", "c"], "x")).toBe("a");
    expect(choice(undefined, ["c"], "x")).toBeUndefined();
    expect(() => choice("d", ["c"], "x")).toThrow(/one of/iu);
    expect(optional(undefined, "x")).toEqual({});
    expect(optional("v", "x")).toEqual({ x: "v" });
    expect(nonBlank("v", "x")).toBe("v");
    expect(() => nonBlank(" ", "x")).toThrow(/empty/iu);
  });

  test("C-CLI-06 validates both adapter effort vocabularies", () => {
    expect(reasoning("claude", undefined)).toBeUndefined();
    expect(reasoning("claude", "xhigh")).toBe("xhigh");
    expect(reasoning("codex", "minimal")).toBe("minimal");
    expect(() => reasoning("claude", "minimal")).toThrow(/one of/iu);
  });
});
