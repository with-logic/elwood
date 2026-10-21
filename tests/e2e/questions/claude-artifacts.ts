/** Retain synthetic native question frames for diagnosing public proofs (PRD §12). */
import { writeFileSync } from "node:fs";
import type { ClaudeSessionApi, ElwoodQuestionEvent } from "../../../src/index.ts";
import { settledCursorVisible } from "../../../src/terminal/cursor.ts";

export function claudeQuestionArtifacts(session: () => ClaudeSessionApi | undefined) {
  const frames: Record<string, unknown> = {};
  return {
    observe() {
      const terminal = session()?.terminal;
      if (!terminal) return;
      const snapshot = terminal.snapshot();
      const stage = snapshot.text.includes("Review your answers")
        ? "review"
        : /^❯\s+Submit$/m.test(snapshot.text)
          ? "submit"
          : snapshot.text.includes("ELWOOD_NOTE_LINE2")
            ? "text"
            : undefined;
      if (stage)
        frames[stage] = {
          ...snapshot,
          cursorVisible: settledCursorVisible(terminal.xterm),
          baseY: terminal.xterm.buffer.active.baseY,
          viewportY: terminal.xterm.buffer.active.viewportY,
        };
    },
    failure(writes: readonly string[], events: readonly ElwoodQuestionEvent[]) {
      const live = session();
      if (!live) return;
      const terminal = live.terminal;
      writeFileSync("/tmp/elwood-claude-question-public-failure.txt", terminal.snapshot().text);
      writeFileSync(
        "/tmp/elwood-claude-question-public-failure.json",
        JSON.stringify(
          {
            snapshot: terminal.snapshot(),
            writes,
            events,
            status: live.status,
            baseY: terminal.xterm.buffer.active.baseY,
            viewportY: terminal.xterm.buffer.active.viewportY,
            cursorVisible: settledCursorVisible(terminal.xterm),
          },
          null,
          2,
        ),
      );
    },
    save() {
      writeFileSync("/tmp/elwood-claude-question-public-stages.json", JSON.stringify(frames));
    },
  };
}
