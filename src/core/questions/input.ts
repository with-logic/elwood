/** Guard native writes with settled, fresh terminal evidence (PRD §4). */
import { cursorViewportRow } from "../../terminal/coordinates.ts";
import {
  captureRenderProgress,
  currentRenderedFrame,
  settledCursorVisible,
  subscribeRender,
} from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { RenderWakeup } from "../input/render-wakeup.ts";
import { untilQuestionAbort } from "./abort.ts";
import { questionCursorProvenance } from "./cursor-provenance.ts";
import { questionAnswerFailed } from "./errors.ts";
import type { QuestionFrame, QuestionIo } from "./io.ts";
import type { QuestionRegistry } from "./registry.ts";
import type { ElwoodQuestionRequest } from "./types.ts";

type WriteObserver = {
  readonly started: () => void;
  readonly settled: () => void;
  readonly failed: () => void;
};

export function readQuestionFrame(terminal: ElwoodTerminal): QuestionFrame | undefined {
  const frame = currentRenderedFrame(terminal);
  const buffer = terminal.xterm.buffer.active;
  return (
    frame && {
      ...frame,
      // Snapshot rows use the viewport; xterm cursorY is relative to the scrollback base.
      cursorRow: cursorViewportRow(frame.cursorY, buffer),
      cursorVisible: settledCursorVisible(terminal.xterm),
      ...questionCursorProvenance(terminal, frame),
    }
  );
}

export function questionInput(
  terminal: ElwoodTerminal,
  registry: QuestionRegistry,
  request: ElwoodQuestionRequest,
  signal: AbortSignal,
  assertLive: () => void,
  observer: WriteObserver,
): QuestionIo {
  let hasOutputSinceWrite: (() => boolean) | undefined;
  const assertActive = () => {
    assertLive();
    if (signal.aborted) throw questionAnswerFailed();
  };
  const assertOwned = () => {
    assertActive();
    if (registry.get(request.id) !== request) throw questionAnswerFailed();
  };
  const io: QuestionIo = {
    signal,
    frame: () => readQuestionFrame(terminal),
    wait: async (test) => {
      const wakeup = new RenderWakeup((listener) => {
        const offRender = subscribeRender(terminal, listener);
        const resize = terminal.xterm.onResize(listener);
        return () => {
          offRender();
          resize.dispose();
        };
      });
      try {
        for (;;) {
          wakeup.consume();
          assertActive();
          const frame = readQuestionFrame(terminal);
          const postWriteProgressSatisfied = !hasOutputSinceWrite || hasOutputSinceWrite();
          if (frame && postWriteProgressSatisfied && test(frame)) return frame;
          assertActive();
          await wakeup.wait(signal);
        }
      } finally {
        wakeup.dispose();
      }
    },
    write: async (input, matchesBeforeWrite, onDispatch) => {
      assertOwned();
      let frame = readQuestionFrame(terminal);
      if (!frame) {
        await io.wait(() => true);
        assertOwned();
        frame = readQuestionFrame(terminal);
      }
      if (!(frame && matchesBeforeWrite(frame))) throw questionAnswerFailed();
      assertOwned();
      hasOutputSinceWrite = captureRenderProgress(terminal);
      observer.started();
      try {
        const send = async () => {
          try {
            onDispatch?.();
            await terminal.sendInput(input);
          } finally {
            observer.settled();
          }
        };
        await untilQuestionAbort(send(), signal);
      } catch {
        observer.failed();
        throw questionAnswerFailed();
      }
      assertActive();
    },
  };
  return io;
}
