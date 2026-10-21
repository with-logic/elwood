/** Shared live native question contract (PRD §5.10). */
import type { ElwoodAgentKind } from "../activity/index.ts";

/** Option IDs belong to this live process and must not be reused after resume. */
export type ElwoodQuestionOption = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
};
/** Question IDs belong to the current live process. */
export type ElwoodQuestion = {
  readonly id: string;
  readonly prompt: string;
  readonly header?: string;
  readonly options: readonly ElwoodQuestionOption[];
  readonly selection: "single" | "multiple" | "none";
  /** Free text is forbidden, replaces choices, or accompanies choices, respectively. */
  readonly textMode: "none" | "alternative" | "additional";
  /** Whether the native question supports entering secret text. */
  readonly supportsSecretInput: boolean;
};
/** Opaque request IDs are process-scoped; a new/resumed process creates new identities.
 * Agent narrows the request's agent; the default distributes into one request type per agent. */
export type ElwoodQuestionRequest<Agent extends ElwoodAgentKind = ElwoodAgentKind> =
  Agent extends ElwoodAgentKind
    ? {
        readonly id: string;
        readonly agent: Agent;
        /** Blocking questions suspend native work; queued questions can coexist with native work. */
        readonly delivery: "blocking" | "queued";
        readonly questions: readonly ElwoodQuestion[];
      }
    : never;
export type ElwoodQuestionAnswer = {
  readonly questionId: string;
  readonly optionIds?: readonly string[];
  readonly text?: string;
};
export type ElwoodQuestionAnswerOptions = {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};
export type QuestionCloseReason = "answered" | "cancelled" | "unavailable";
/** Agent narrows both envelope and nested request agents. The default distributes across
 * agents and lifecycle phases, preserving agent identity and phase-specific fields in each branch. */
export type ElwoodQuestionEvent<Agent extends ElwoodAgentKind = ElwoodAgentKind> =
  Agent extends ElwoodAgentKind
    ? {
        readonly elwoodSessionId: string;
        readonly agent: Agent;
        readonly request: ElwoodQuestionRequest<Agent>;
      } & (
        | { readonly phase: "raised" }
        | { readonly phase: "closed"; readonly reason: QuestionCloseReason }
      )
    : never;
export interface QuestionControls {
  /** Discovery-ordered, deeply immutable point-in-time snapshot; retained snapshots do not update.
   * Listing bypasses an active ergonomic turn. IDs expire with this live process. */
  listQuestions(): Promise<readonly ElwoodQuestionRequest[]>;
  answerQuestions(
    requestId: string,
    answers: readonly ElwoodQuestionAnswer[],
    options?: ElwoodQuestionAnswerOptions,
  ): Promise<void>;
}
/** Adapters supply native content; the registry generates request, question, and option IDs. */
export type QuestionDefinition = Omit<ElwoodQuestion, "id" | "options"> & {
  readonly options: readonly Omit<ElwoodQuestionOption, "id">[];
};
