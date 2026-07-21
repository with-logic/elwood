/**
 * Coverage for Claude hook result updatedInput/updatedPermissions validation.
 * Covers PRD §6.4, C-HOOK-09, and C-HRESP-01.
 */

import { describe, expect, test } from "vitest";
import { permReq, updateFor } from "./claude-result-validate-helpers.ts";

describe("Claude hook result update validation", () => {
  test("C-HOOK-09 validates updatedInput keys against the named tool", () => {
    const agent = { tool_name: "Agent", tool_input: { prompt: "p" } } as const;
    expect(updateFor(agent, { prompt: "revised" })).toBe(true);
    expect(updateFor(agent, { command: "no" })).toBe(false);
    expect(updateFor({ tool_name: "ExitPlanMode", tool_input: {} }, { plan: "steps" })).toBe(true);
    expect(
      updateFor({ tool_name: "Glob", tool_input: { pattern: "*.ts" } }, { pattern: "*.tsx" }),
    ).toBe(true);
    expect(updateFor({ tool_name: "Read", tool_input: { file_path: "a.ts" } }, { limit: 5 })).toBe(
      true,
    );
    expect(
      updateFor(
        { tool_name: "WebFetch", tool_input: { url: "https://e.test", prompt: "read" } },
        { url: "https://e2.test" },
      ),
    ).toBe(true);
    expect(
      updateFor({ tool_name: "WebSearch", tool_input: { query: "docs" } }, { query: "guides" }),
    ).toBe(true);
    expect(
      updateFor(
        { tool_name: "Write", tool_input: { file_path: "a.ts", content: "x" } },
        { content: "y" },
      ),
    ).toBe(true);
  });

  test("C-HOOK-09 rejects updatedInput whose value TYPES do not match the tool", () => {
    const bash = { tool_name: "Bash", tool_input: { command: "ok" } } as const;
    // {command: 42} used to pass because only KEYS were checked (PRD §6.4).
    expect(updateFor(bash, { command: 42 })).toBe(false);
    expect(updateFor(bash, { timeout: "soon" })).toBe(false);
    expect(updateFor(bash, { run_in_background: "yes" })).toBe(false);
    expect(updateFor(bash, { command: "still ok", timeout: 5000 })).toBe(true);
    const read = { tool_name: "Read", tool_input: { file_path: "a.ts" } } as const;
    expect(updateFor(read, { offset: "0" })).toBe(false);
    expect(updateFor(read, { offset: 0, limit: 5 })).toBe(true);
    const edit = {
      tool_name: "Edit",
      tool_input: { file_path: "a.ts", old_string: "a", new_string: "b" },
    } as const;
    expect(updateFor(edit, { replace_all: "true" })).toBe(false);
    const web = { tool_name: "WebSearch", tool_input: { query: "docs" } } as const;
    expect(updateFor(web, { allowed_domains: ["e.test"] })).toBe(true);
    expect(updateFor(web, { allowed_domains: [1] })).toBe(false);
    const grep = { tool_name: "Grep", tool_input: { pattern: "x" } } as const;
    expect(updateFor(grep, { output_mode: "content" })).toBe(true);
    expect(updateFor(grep, { output_mode: "bogus" })).toBe(false);
    const ask = { tool_name: "AskUserQuestion", tool_input: { questions: [] } } as const;
    expect(
      updateFor(ask, {
        questions: [{ question: "Q?", header: "H", options: [{ label: "A" }] }],
      }),
    ).toBe(true);
    expect(updateFor(ask, { questions: [{ question: "Q?" }] })).toBe(false);
    expect(updateFor(ask, { questions: ["not-a-question"] })).toBe(false);
    expect(updateFor(ask, { answers: { q: "a" } })).toBe(true);
    expect(updateFor(ask, { answers: { q: 1 } })).toBe(false);
  });

  test("C-HRESP-01 validates PermissionRequest updatedInput and updatedPermissions", () => {
    const bash = { hook_event_name: "PermissionRequest", tool_name: "Bash" };
    // updatedInput is checked against the tool shape, not just "is a record".
    expect(permReq(bash, { behavior: "allow", updatedInput: { command: 42 } })).toBe(false);
    expect(permReq(bash, { behavior: "allow", updatedInput: { command: "ls" } })).toBe(true);
    // updatedPermissions entries must match a PermissionUpdate variant.
    expect(permReq(bash, { behavior: "allow", updatedPermissions: [42] })).toBe(false);
    expect(
      permReq(bash, {
        behavior: "allow",
        updatedPermissions: [
          {
            type: "addRules",
            behavior: "allow",
            destination: "session",
            rules: [{ toolName: "Bash", ruleContent: "ls" }],
          },
        ],
      }),
    ).toBe(true);
    expect(
      permReq(bash, {
        behavior: "allow",
        updatedPermissions: [{ type: "setMode", mode: "plan", destination: "session" }],
      }),
    ).toBe(true);
    expect(
      permReq(bash, {
        behavior: "allow",
        updatedPermissions: [{ type: "setMode", mode: "yolo", destination: "session" }],
      }),
    ).toBe(false);
    expect(
      permReq(bash, {
        behavior: "allow",
        updatedPermissions: [
          { type: "addDirectories", directories: ["/a"], destination: "userSettings" },
        ],
      }),
    ).toBe(true);
    expect(
      permReq(bash, {
        behavior: "allow",
        updatedPermissions: [
          { type: "removeDirectories", directories: [1], destination: "session" },
        ],
      }),
    ).toBe(false);
    expect(
      permReq(bash, {
        behavior: "allow",
        updatedPermissions: [{ type: "addRules", destination: "session" }],
      }),
    ).toBe(false);
    expect(
      permReq(bash, {
        behavior: "allow",
        updatedPermissions: [{ type: "unknown", destination: "session" }],
      }),
    ).toBe(false);
    expect(
      permReq(bash, {
        behavior: "allow",
        updatedPermissions: [
          { type: "addRules", behavior: "allow", destination: "nowhere", rules: [] },
        ],
      }),
    ).toBe(false);
    expect(
      permReq(bash, {
        behavior: "allow",
        updatedPermissions: [
          {
            type: "addRules",
            behavior: "allow",
            destination: "session",
            rules: [{ ruleContent: "x" }],
          },
        ],
      }),
    ).toBe(false);
    expect(permReq(bash, { behavior: "allow", updatedPermissions: "nope" })).toBe(false);
    // A rule entry that is not a record is rejected.
    expect(
      permReq(bash, {
        behavior: "allow",
        updatedPermissions: [
          { type: "addRules", behavior: "allow", destination: "session", rules: ["not-a-rule"] },
        ],
      }),
    ).toBe(false);
  });
});
