/** Shared live native question contract (PRD §4). */
import type { ElwoodAgentKind } from "../activity/index.ts";

export type ElwoodQuestionOption = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
};
export type ElwoodQuestion = {
  readonly id: string;
  readonly prompt: string;
  readonly header?: string;
  readonly options: readonly ElwoodQuestionOption[];
  readonly selection: "single" | "multiple" | "none";
  /** Free text is forbidden, replaces choices, or accompanies choices, respectively. */
  readonly textMode: "none" | "alternative" | "additional";
  /** Whether the native question supports entering secret text. */
  readonly secret: boolean;
};
export type ElwoodQuestionRequest = {
  readonly id: string;
  readonly agent: ElwoodAgentKind;
  /** Blocking questions suspend native work; queued questions can coexist with native work. */
  readonly delivery: "blocking" | "queued";
  readonly questions: readonly ElwoodQuestion[];
};
export type QuestionCloseReason = "answered" | "cancelled" | "unavailable";
export type ElwoodQuestionEvent = {
  readonly elwoodSessionId: string;
  readonly agent: ElwoodAgentKind;
  readonly request: ElwoodQuestionRequest;
} & (
  | { readonly phase: "raised" }
  | { readonly phase: "closed"; readonly reason: QuestionCloseReason }
);
/** Adapters supply native content; the registry generates request, question, and option IDs. */
export type QuestionDefinition = Omit<ElwoodQuestion, "id" | "options"> & {
  readonly options: readonly Omit<ElwoodQuestionOption, "id">[];
};
