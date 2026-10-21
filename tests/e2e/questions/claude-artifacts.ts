/** Retain synthetic native question frames for diagnosing public proofs (PRD §12). */
import type { ClaudeSessionApi, ElwoodQuestionEvent } from "../../../src/index.ts";
import { settledCursorVisible } from "../../../src/terminal/cursor.ts";
import { noteLastLine } from "./claude-cases.ts";
import { privateQuestionArtifacts } from "./proof-files.ts";

type ArtifactStage = "review" | "submit" | "text";

/** Owns private diagnostic files; observe/failure/save suppress both capture and diagnostic errors.
 * The caller owns removing root after the native session has closed.
 */
export function claudeQuestionArtifacts(
  session: () => Pick<ClaudeSessionApi, "terminal" | "status"> | undefined,
  root: string,
  diagnostic: (message: string) => void,
) {
  let artifacts: ReturnType<typeof privateQuestionArtifacts> | undefined;
  const frames: Partial<Record<ArtifactStage, unknown>> = {};
  const bestEffort = (capture: () => void) => {
    try {
      capture();
    } catch {
      try {
        diagnostic("Claude question diagnostic artifact capture failed");
      } catch {
        // Diagnostics must never prevent native-session and credential cleanup.
      }
    }
  };
  bestEffort(() => {
    artifacts = privateQuestionArtifacts(root);
  });
  return {
    observe() {
      bestEffort(() => {
        const terminal = session()?.terminal;
        if (!terminal) return;
        const snapshot = terminal.snapshot();
        const stage: ArtifactStage | undefined = snapshot.text.includes("Review your answers")
          ? "review"
          : /^❯\s+Submit$/m.test(snapshot.text)
            ? "submit"
            : snapshot.text.includes(noteLastLine)
              ? "text"
              : undefined;
        if (stage)
          frames[stage] = {
            ...snapshot,
            cursorVisible: settledCursorVisible(terminal.xterm),
            baseY: terminal.xterm.buffer.active.baseY,
            viewportY: terminal.xterm.buffer.active.viewportY,
          };
      });
    },
    failure(writes: readonly string[], events: readonly ElwoodQuestionEvent[]) {
      bestEffort(() => {
        const live = session();
        if (!live) return;
        const terminal = live.terminal;
        artifacts?.write("failure-screen", terminal.snapshot().text);
        artifacts?.write(
          "failure",
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
      });
    },
    save() {
      bestEffort(() => {
        artifacts?.write("stages", JSON.stringify(frames));
      });
    },
  };
}
