/**
 * A Claude permission dialog declined with Escape leaves the session `ready` (C-ATTN-02),
 * replayed from Claude Code 2.1.310's own frames
 * (`tests/fixtures/claude-2.1.310/permission-declined/`, see the README). After the
 * decline the transcript still shows the prompt Claude echoed as `❯ <prompt>`, above the
 * idle composer, its rules, and its footer.
 */

import { afterEach, expect, test } from "vitest";
import { liveClaudeIdleComposer } from "../../src/claude/composer/idle.ts";
import { liveClaudeClearance } from "../../src/claude/screen-table.ts";
import { startClaude } from "../../src/index.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { readNativeInputFrame } from "../fixtures/native-input-frame.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

type NativeFrame = ReturnType<typeof readNativeInputFrame>;
const capture = (name: string) =>
  readNativeInputFrame(
    new URL(`../fixtures/claude-2.1.310/permission-declined/${name}.json`, import.meta.url),
  );
const dialog = capture("dialog");
const declined = capture("declined");

/** The bytes that repaint `frame` whole: its rows, cursor, cursor visibility, and title. */
const paint = (frame: NativeFrame) =>
  `\u001b[2J\u001b[H${frame.text.replaceAll("\n", "\r\n")}` +
  `\u001b[${frame.cursorY + 1};${frame.cursorX + 1}H\u001b[?25${frame.visible ? "h" : "l"}` +
  `\u001b]0;${frame.title}\u0007`;

test("C-ATTN-02 the declined frame is idle only past the prompt its transcript echoes", async () => {
  const echoed = declined.text.split("\n").filter((row) => row.startsWith("❯ Create a file"));
  expect(echoed).toHaveLength(1);
  const terminal = createHeadlessTerminal({ cols: declined.cols, rows: declined.rows }, () => {});
  try {
    await terminal.writeOutput(paint(declined));
    const text = terminal.snapshot().text;
    expect(liveClaudeClearance(() => terminal)(text)).toBe(false); // the echoed prompt's caret
    expect(liveClaudeIdleComposer(() => terminal)(text)).toBe(true);
    await terminal.writeOutput(paint(dialog));
    expect(liveClaudeIdleComposer(() => terminal)(terminal.snapshot().text)).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test("C-ATTN-02 a Claude session whose permission dialog is declined returns to ready", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({
    cwd,
    initialSize: { cols: declined.cols, rows: declined.rows },
  });
  try {
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    await expect.poll(() => session.status).toBe("ready");
    ptys[0]!.emitData(paint(dialog));
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    const before = ptys[0]!.writes.length;
    const queued = session.sendMessage("queued follow-up");
    void queued.catch(() => undefined);
    ptys[0]!.emitData(paint(declined));
    await session.terminal.settled();
    expect(session.statusDecisions()).toContainEqual(
      expect.objectContaining({
        evidence: "blocking_prompt_cleared",
        from: "blocked",
        to: "ready",
      }),
    );
    await queued; // the queue released the follow-up into the idle composer
    expect(ptys[0]!.writes.slice(before)).toEqual(["\u001b[200~queued follow-up\u001b[201~", "\r"]);
  } finally {
    await session.teardown();
  }
});
