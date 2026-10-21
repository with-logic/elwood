/** Caller hook decisions precede native discovery, including matching stale panels (C-QUESTION-01). */
import { afterEach, expect, test } from "vitest";
import { type AskUserQuestionInput, startClaude } from "../../src/index.ts";
import { fixture } from "../unit/questions/helpers.ts";
import { nativeQuestions } from "../unit/questions/lifecycle-helpers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
test.each([
  "PreToolUse",
  "PermissionRequest",
] as const)("C-QUESTION-01 %s direct answer cannot expose a phantom before completion", async (name) => {
  installFakes();
  const cwd = tempDir();
  let direct = true;
  const input = {
    questions: nativeQuestions.map((question) => ({ ...question, header: question.header ?? "" })),
  } satisfies AskUserQuestionInput;
  const session = await startClaude({
    cwd,
    initialSize: { cols: 140, rows: 45 },
    hooks: {
      PreToolUse: {
        AskUserQuestion: () =>
          direct && name === "PreToolUse"
            ? { permissionDecision: "allow", updatedInput: { answers: { Color: "Amber" } } }
            : undefined,
      },
      PermissionRequest: {
        AskUserQuestion: () =>
          direct ? { behavior: "allow", updatedInput: { answers: { Color: "Amber" } } } : undefined,
      },
    },
  });
  try {
    const pty = ptys[0]!;
    await pty.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "native",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    const events: unknown[] = [];
    session.on("question", (event) => events.push(event));
    const hook = (tool_use_id: string, hookName = name) =>
      pty.dispatchHook(session.elwoodSessionId, {
        hook_event_name: hookName,
        session_id: "native",
        cwd,
        tool_name: "AskUserQuestion",
        tool_use_id,
        tool_input: input,
      });
    const show = async () => {
      const frame = fixture("questions");
      pty.emitData(`\x1b[H\x1b[2J${frame.lines.join("\r\n")}\x1b[${frame.cursorRow + 1};1H`);
      await session.terminal.settled();
    };
    if (name === "PermissionRequest") await hook("direct", "PreToolUse");
    await hook("direct");
    await show();
    expect(await session.listQuestions()).toEqual([]);
    expect(events).toEqual([]);
    direct = false;
    if (name === "PermissionRequest") await hook("unanswered", "PreToolUse");
    await hook("unanswered");
    expect(await session.listQuestions()).toEqual([]);
    await show();
    expect(await session.listQuestions()).toHaveLength(1);
    expect(events).toHaveLength(1);
  } finally {
    await session.kill();
  }
});
