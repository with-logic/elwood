/** Dedicated answer lane bypasses blocked ordinary queues (PRD §5.10, C-QUESTION-02). */
import {
  captureRenderProgress,
  currentRenderedFrame,
  settledCursorVisible,
} from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { delay } from "../delay.ts";
import { elwoodError } from "../errors.ts";
import type { QuestionAdapter, QuestionFrame, QuestionIo } from "./adapter.ts";
import type { QuestionRegistry } from "./registry.ts";
import type { ElwoodQuestionAnswer, ElwoodQuestionAnswerOptions } from "./types.ts";
import { questionTimeout, validateQuestionAnswers } from "./validate.ts";

export function readQuestionFrame(terminal: ElwoodTerminal): QuestionFrame | undefined {
  const frame = currentRenderedFrame(terminal);
  const buffer = terminal.xterm.buffer.active;
  return (
    frame && {
      ...frame,
      cursorRow: frame.cursorY + buffer.baseY - buffer.viewportY,
      cursorVisible: settledCursorVisible(terminal.xterm),
    }
  );
}
export class QuestionTransaction {
  private active: AbortController | undefined;
  private readonly registry: QuestionRegistry;
  private readonly terminal: ElwoodTerminal;
  private readonly inputSignal: () => AbortSignal;
  private readonly closing: AbortSignal;
  constructor(
    registry: QuestionRegistry,
    terminal: ElwoodTerminal,
    inputSignal: () => AbortSignal,
    closing: AbortSignal,
  ) {
    this.registry = registry;
    this.terminal = terminal;
    this.inputSignal = inputSignal;
    this.closing = closing;
  }
  busy(): boolean {
    return this.active !== undefined;
  }
  revoke(): void {
    this.active?.abort(failed());
  }
  async run(
    adapter: QuestionAdapter | undefined,
    id: string,
    answers: readonly ElwoodQuestionAnswer[],
    options?: ElwoodQuestionAnswerOptions,
  ): Promise<void> {
    const request = this.registry.get(id);
    if (!request)
      throw elwoodError(
        "question_not_found",
        "The native question request is no longer available.",
      );
    const timeoutMs = questionTimeout(options);
    const validated = validateQuestionAnswers(request, answers);
    if (this.active || !adapter) throw failed();
    const operation = new AbortController();
    let signal: AbortSignal;
    try {
      signal = AbortSignal.any([
        operation.signal,
        this.closing,
        this.inputSignal(),
        ...(options?.signal === undefined ? [] : [options.signal]),
      ]);
    } catch {
      throw elwoodError("invalid_question_answer", "The question answer options are invalid.");
    }
    this.active = operation;
    const deadline = setTimeout(() => operation.abort(failed()), timeoutMs);
    let accepted = false;
    const off = this.registry.onEvent((event) => {
      if (event.phase !== "closed" || event.request.id !== id) return;
      if (event.reason === "answered") accepted = true;
      else operation.abort(failed());
    });
    const assertLive = () => {
      if (signal.aborted || !(accepted || this.registry.get(id))) throw failed();
    };
    let progressed: (() => boolean) | undefined;
    const io: QuestionIo = {
      signal,
      frame: () => readQuestionFrame(this.terminal),
      wait: async (test) => {
        for (;;) {
          assertLive();
          const frame = readQuestionFrame(this.terminal);
          if (frame && (!progressed || progressed()) && test(frame)) return frame;
          await delay(20);
        }
      },
      write: async (input, expected) => {
        assertLive();
        if (this.registry.get(id) !== request) throw failed();
        let frame = readQuestionFrame(this.terminal);
        if (!frame) {
          await io.wait(() => true);
          assertLive();
          if (this.registry.get(id) !== request) throw failed();
          frame = readQuestionFrame(this.terminal);
        }
        if (!(frame && expected(frame))) throw failed();
        progressed = captureRenderProgress(this.terminal);
        await this.terminal.sendInput(input);
        assertLive();
      },
    };
    try {
      assertLive();
      await io.wait(() => true);
      await adapter.answer(request, validated, io);
      while (!accepted) {
        assertLive();
        await delay(20);
      }
      assertLive();
    } catch {
      throw failed();
    } finally {
      operation.abort();
      clearTimeout(deadline);
      off();
      this.active = undefined;
    }
  }
}
function failed() {
  return elwoodError(
    "question_answer_failed",
    "The native question answer could not be confirmed.",
  );
}
