/** Preserves valid nullable descriptions through Codex handlers and serialization (PRD §7A.2). */

import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  "Bash",
  "apply_patch",
])("C-HRESP-07 preserves %s null descriptions in copied rewrites", async (tool_name) => {
  const cwd = tempDir();
  installFakes();
  const session = await startCodex({
    cwd,
    hooks: {
      PreToolUse: {
        Bash: (event) => ({
          permissionDecision: "allow",
          updatedInput: { ...event.tool_input, command: "after" },
        }),
        apply_patch: (event) => ({
          permissionDecision: "allow",
          updatedInput: { ...event.tool_input, command: "after" },
        }),
      },
    },
  });
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "PreToolUse",
    session_id: "codex-1",
    cwd,
    turn_id: "turn-1",
    tool_name,
    tool_input: { command: "before", description: null },
  });
  expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toEqual({
    command: "after",
    description: null,
  });
});
