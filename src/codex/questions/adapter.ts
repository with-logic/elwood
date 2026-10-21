/** Live Codex question registry and native answer routing (PRD §7A.5, C-QUESTION-01/02). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import type { QuestionAdapter, QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import type { ElwoodQuestionRequest } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { codexEmptyInputRows } from "../screen/empty-input.ts";
import { CodexQuestionCandidates } from "./candidates.ts";
import { answerBlocking, answerQueued, failedQuestion } from "./driver.ts";
import { matchesQuestion, type QuestionView, questionView, queuedBadge } from "./frame.ts";

export class CodexQuestionAdapter implements QuestionAdapter {
  private readonly state: CodexQuestionCandidates;
  private readonly registry: QuestionRegistry;
  private focused: string | undefined;
  private count = 0;
  private hold = false;
  constructor(registry: QuestionRegistry) {
    this.registry = registry;
    this.state = new CodexQuestionCandidates(registry);
  }
  observe(event: ElwoodActivityEvent): void {
    if (this.state.observe(event) || this.state.candidates.size === 0) {
      this.focused = undefined;
      this.count = 0;
    }
  }
  render(frame: QuestionFrame): void {
    const view = questionView(frame);
    const badge = queuedBadge(frame);
    this.hold =
      view !== undefined ||
      badge !== undefined ||
      /^\s*Question \d+\/\d+ \(\d+ unanswered\)$/m.test(frame.text);
    if (view?.kind === "queued") this.observeQueued(view);
    this.observeComposer(frame);
    const available = this.state.queued();
    if ((badge ?? (view?.kind === "queued" ? view.count : undefined)) === available.length) {
      for (const candidate of available) this.state.publish(candidate);
    }
    if (view?.kind === "blocking") {
      for (const candidate of this.state.candidates.values()) {
        if (
          !candidate.queued &&
          candidate.questions.length === view.count &&
          matchesQuestion(view, candidate.questions[view.index]!.definition)
        )
          this.state.publish(candidate);
      }
    }
    if (this.state.candidates.size === 0) {
      this.focused = undefined;
      this.count = 0;
    }
  }
  blocksInput(): boolean {
    return this.hold;
  }
  async answer(
    request: ElwoodQuestionRequest,
    answers: readonly ValidatedQuestionAnswer[],
    io: QuestionIo,
  ): Promise<void> {
    const key = this.registry.keyFor(request.id);
    const candidate = key === undefined ? undefined : this.state.candidates.get(key);
    if (!candidate) throw failedQuestion();
    const submitting = () => {
      candidate.submitting = !io.signal.aborted;
      io.signal.addEventListener(
        "abort",
        () => {
          candidate.submitting = false;
          const frame = io.frame();
          if (frame) this.render(frame);
        },
        { once: true },
      );
    };
    if (candidate.queued) {
      const queued = this.state.queued();
      await answerQueued(
        queued.map((item) => item.questions[0]!.definition),
        answers[0]!,
        queued.indexOf(candidate),
        io,
        submitting,
      );
    } else
      await answerBlocking(
        candidate.questions.map((question) => question.definition),
        answers,
        io,
        submitting,
      );
  }
  private observeComposer(frame: QuestionFrame): void {
    if (
      !(this.hold || frame.lines.includes("• Queued follow-up inputs")) &&
      frame.cursorX === 2 &&
      codexEmptyInputRows(frame.lines, frame.cursorRow)
    ) {
      for (const candidate of this.state.queued()) {
        if (!candidate.submitting) this.state.close(candidate.key, "unavailable");
      }
    }
  }
  private observeQueued(view: QuestionView): void {
    const queued = this.state.queued();
    {
      const matches = queued.filter((candidate) =>
        matchesQuestion(view, candidate.questions[0]!.definition),
      );
      const current =
        queued.length === view.count
          ? queued[view.index]
          : matches.length === 1
            ? matches[0]
            : undefined;
      if (current && matchesQuestion(view, current.questions[0]!.definition)) {
        if (this.focused && this.focused !== current.key && this.count === view.count + 1) {
          const previous = this.state.candidates.get(this.focused);
          if (previous && !previous.submitting) this.state.close(previous.key, "unavailable");
        }
        this.focused = current.key;
      }
      this.count = view.count;
    }
  }
}
