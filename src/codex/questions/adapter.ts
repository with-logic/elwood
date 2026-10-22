/** Reconcile private Codex question UI and route guarded native answers (PRD §4). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import type { QuestionAdapter, QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import type { ElwoodQuestionRequest } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { codexEmptyInputRows } from "../screen/empty-input.ts";
import { hasInFlightSubmission, type QueuedCandidate } from "./candidate.ts";
import { type Candidate, CodexQuestionCandidates } from "./candidates.ts";
import { answerBlocking, answerQueued } from "./driver.ts";
import { matchesQuestion, type QuestionView, questionView, queuedBadge } from "./frame.ts";
import { nativeQuestionFragment } from "./native-pending.ts";
import { PendingSubmissions } from "./pending-submissions.ts";

export class CodexQuestionAdapter implements QuestionAdapter {
  private readonly state: CodexQuestionCandidates;
  private readonly registry: QuestionRegistry;
  private readonly candidatesSeenInNativeUi = new WeakSet<Candidate>();
  private readonly pending = new PendingSubmissions();
  private focused: Candidate | undefined;
  private previousQuestionCount = 0;
  private hold = false;
  private composerEligibilityChecked = false;
  constructor(registry: QuestionRegistry, onDisabled?: () => void) {
    this.registry = registry;
    this.state = new CodexQuestionCandidates(registry, onDisabled);
  }
  observe(event: ElwoodActivityEvent): boolean {
    return this.state.batchNotifications(() => {
      const changed = this.state.observe(event);
      if (changed) this.composerEligibilityChecked = false;
      if (this.focused && this.state.candidates.get(this.focused.nativeKey) !== this.focused) {
        this.focused = undefined;
        this.previousQuestionCount = 0;
      }
      return changed;
    });
  }
  render(frame: QuestionFrame): void {
    this.state.batchNotifications(() => {
      const view = questionView(frame);
      const badge = queuedBadge(frame);
      const chrome = view !== undefined || badge !== undefined || nativeQuestionFragment(frame);
      if (chrome) {
        this.hold = true;
        this.composerEligibilityChecked = false;
      }
      this.pending.observe(frame, view, this.state);
      const current = view?.kind === "queued" ? this.observeQueued(view) : undefined;
      const available = this.state.availableAcceptedQueuedCandidates();
      const queuedConfirmed =
        (badge === available.length && !this.state.hasOpaqueReservation()) ||
        (current !== undefined && view?.count === available.length);
      this.publishConfirmedCandidates(view, queuedConfirmed);
      this.observeComposer(frame, chrome);
    });
  }
  blocksInput(): boolean {
    return this.hold || this.state.hasReservation();
  }
  async answer(
    request: ElwoodQuestionRequest,
    answers: readonly ValidatedQuestionAnswer[],
    io: QuestionIo,
  ): Promise<void> {
    this.composerEligibilityChecked = false;
    const nativeKey = this.registry.keyFor(request.id);
    const candidate = nativeKey === undefined ? undefined : this.state.candidates.get(nativeKey);
    if (!candidate || candidate.hasPendingNativeSubmission) throw questionAnswerFailed();
    // Physical dispatch retains native ownership even if the caller stops waiting.
    const submitting = () => this.state.setSubmitting(candidate, true);
    let answerNative: () => Promise<void>;
    if (candidate.queued) {
      if (answers.length !== 1) throw questionAnswerFailed();
      const [answer] = answers;
      if (answer === undefined) throw questionAnswerFailed();
      const queued = this.state.availableAcceptedQueuedCandidates();
      answerNative = () =>
        answerQueued(
          queued.map((item) => item.questions[0].definition),
          answer,
          // biome-ignore lint/complexity/useIndexOf: the accepted snapshot has a narrower element type than candidate.
          queued.findIndex((item) => item === candidate),
          io,
          submitting,
        );
    } else
      answerNative = () =>
        answerBlocking(
          candidate.questions.map((question) => question.definition),
          answers,
          io,
          submitting,
        );
    const abandon = this.state.expectAnswer(candidate, answers, io.signal);
    try {
      await answerNative();
    } catch (error) {
      abandon();
      this.composerEligibilityChecked = false;
      throw error;
    }
  }

  private publishConfirmedCandidates(
    view: QuestionView | undefined,
    queuedConfirmed: boolean,
  ): void {
    for (const candidate of this.state.unpublishedCandidates()) {
      if (candidate.queued) {
        if (queuedConfirmed && candidate.accepted && !candidate.hasPendingNativeSubmission) {
          this.markSeen(candidate);
          this.state.publish(candidate);
        }
      } else if (
        view?.kind === "blocking" &&
        candidate.questions.length === view.count &&
        matchesQuestion(view, candidate.questions[view.index]!.definition)
      ) {
        this.markSeen(candidate);
        this.state.publish(candidate);
      }
    }
  }
  private markSeen(candidate: Candidate): void {
    if (!this.candidatesSeenInNativeUi.has(candidate)) {
      this.candidatesSeenInNativeUi.add(candidate);
      this.composerEligibilityChecked = false;
    }
  }
  private observeComposer(frame: QuestionFrame, chrome: boolean): void {
    if (
      chrome ||
      frame.cursorVisible !== true ||
      frame.cursorX !== 2 ||
      !codexEmptyInputRows(frame.lines, frame.cursorRow)
    )
      return;
    this.hold = false;
    // Only native eligibility changes invalidate this scan; unrelated viewport redraws do not.
    if (this.composerEligibilityChecked) return;
    this.composerEligibilityChecked = true;
    for (const candidate of this.state.candidates.values()) {
      if (
        this.candidatesSeenInNativeUi.has(candidate) &&
        !hasInFlightSubmission(candidate) &&
        !this.pending.isAmbiguous(candidate)
      )
        this.state.close(candidate.nativeKey, "unavailable");
    }
    // Unknown native identities cannot be correlated to a later panel. Turn end releases them.
  }
  private observeQueued(view: QuestionView): Candidate | undefined {
    const queued = this.state.availableAcceptedQueuedCandidates();
    const current = queuedCandidate(queued, view);
    if (current) {
      this.markSeen(current);
      const previous = this.focused;
      // A one-item decrease or remaining singleton permits retiring another focused candidate.
      const canRetirePreviousCandidate =
        previous !== current && (this.previousQuestionCount === view.count + 1 || view.count === 1);
      if (previous) {
        const retirementEligible = !(
          hasInFlightSubmission(previous) || this.pending.isAmbiguous(previous)
        );
        if (canRetirePreviousCandidate && retirementEligible)
          this.state.close(previous.nativeKey, "unavailable");
      }
      this.focused = current;
    }
    this.previousQuestionCount = view.count;
    return current;
  }
}
/** Use position only when counts agree; otherwise require one unambiguous definition match. */
function queuedCandidate(
  queued: readonly QueuedCandidate[],
  view: QuestionView,
): QueuedCandidate | undefined {
  if (queued.length === view.count) {
    const indexed = queued[view.index]!;
    return matchesQuestion(view, indexed.questions[0].definition) ? indexed : undefined;
  }
  let match: QueuedCandidate | undefined;
  for (const candidate of queued) {
    if (!matchesQuestion(view, candidate.questions[0].definition)) continue;
    if (match) return undefined;
    match = candidate;
  }
  return match;
}
