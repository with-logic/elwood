/** Shared native-question session bootstrap and committed hook barrier (PRD §5.10). */

import type { QuestionFrame } from "../../src/core/questions/adapter.ts";
import {
  type AskUserQuestionInput,
  type ClaudeHookHandlers,
  type ClaudeSessionApi,
  startClaude,
} from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: ClaudeSessionApi[] = [];
export async function disposeQuestionSessions(): Promise<void> {
  try {
    await Promise.all(sessions.splice(0).map((session) => session.kill()));
  } finally {
    resetFakes();
  }
}
export async function questionSession(
  input: AskUserQuestionInput,
  hooks?: ClaudeHookHandlers,
  nativeId?: string,
) {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({
    cwd,
    initialSize: { cols: 140, rows: 45 },
    ...(hooks ? { hooks } : {}),
  });
  sessions.push(session);
  const pty = ptys[0]!;
  await pty.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "InstructionsLoaded",
    session_id: "native",
    cwd,
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  });
  const hook = async (name: string, fields: Readonly<Record<string, unknown>> = {}) => {
    const result = await pty.dispatchHook(session.elwoodSessionId, {
      hook_event_name: name,
      session_id: "native",
      cwd,
      tool_name: "AskUserQuestion",
      tool_input: input,
      ...(nativeId === undefined ? {} : { tool_use_id: nativeId }),
      ...fields,
    });
    // Hook IPC is committed; drain its synchronous observers' Promise reactions before asserting.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return result;
  };
  const show = async (frame: QuestionFrame) => {
    pty.emitData(`\x1b[H\x1b[2J${frame.lines.join("\r\n")}\x1b[${frame.cursorRow + 1};1H`);
    await session.terminal.settled();
  };
  return { session, pty, hook, show };
}
