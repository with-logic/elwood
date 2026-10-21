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
  readonly textMode: "none" | "alternative" | "additional";
  readonly secret: boolean;
};
export type ElwoodQuestionRequest = {
  readonly id: string;
  readonly agent: ElwoodAgentKind;
  readonly delivery: "blocking" | "queued";
  readonly questions: readonly ElwoodQuestion[];
};
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
export type ElwoodQuestionEvent = {
  readonly elwoodSessionId: string;
  readonly agent: ElwoodAgentKind;
  readonly request: ElwoodQuestionRequest;
} & (
  | { readonly phase: "raised" }
  | { readonly phase: "closed"; readonly reason: QuestionCloseReason }
);
export interface QuestionControls {
  listQuestions(): Promise<readonly ElwoodQuestionRequest[]>;
  answerQuestions(
    requestId: string,
    answers: readonly ElwoodQuestionAnswer[],
    options?: ElwoodQuestionAnswerOptions,
  ): Promise<void>;
}
export type QuestionDefinition = Omit<ElwoodQuestion, "id" | "options"> & {
  readonly options: readonly Omit<ElwoodQuestionOption, "id">[];
};
