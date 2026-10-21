/** Consume each visible native pending occurrence once, without answer text (PRD §4). */
import type { QuestionFrame } from "../../core/questions/adapter.ts";
import { codexWorkingScreen } from "../screen/working.ts";
import type { Candidate, CodexQuestionCandidates } from "./candidates.ts";
import { matchesQuestion, type QuestionView } from "./frame.ts";
import { nativePendingPrompts } from "./native-pending.ts";

export class PendingSubmissions {
  private previous = new Map<string, number>();
  private readonly ambiguous = new WeakSet<Candidate>();
  /** Title-count ambiguity only; exact deferred acceptance is candidate.awaitingNative. */
  isAmbiguous(candidate: Candidate): boolean {
    return this.ambiguous.has(candidate);
  }
  observe(
    frame: QuestionFrame,
    view: QuestionView | undefined,
    state: CodexQuestionCandidates,
  ): void {
    // A clipped working marker cannot establish that old pending rows disappeared.
    if (!frame.lines.some((line) => codexWorkingScreen.test(line))) return;
    const counts = new Map<string, number>();
    for (const prompt of nativePendingPrompts(frame))
      counts.set(prompt, (counts.get(prompt) ?? 0) + 1);
    for (const [prompt, count] of counts) {
      const added = count - (this.previous.get(prompt) ?? 0);
      if (added <= 0) continue;
      const queued = state.acceptedQueuedCandidates();
      const live =
        view?.kind === "queued"
          ? queued.filter((candidate) => matchesQuestion(view, candidate.questions[0].definition))
          : [];

      const candidates = queued.filter(
        (candidate) =>
          candidate.questions[0].definition.prompt === prompt &&
          !(live.length === 1 && live[0] === candidate),
      );
      if (candidates.length === added) {
        for (const candidate of candidates) state.markPendingSubmission(candidate);
      } else {
        // Pending rows contain titles, not IDs. Keep uncertain identities until
        // a native acceptance or turn boundary disambiguates them.
        for (const candidate of candidates) this.ambiguous.add(candidate);
      }
    }
    this.previous = counts;
  }
}
