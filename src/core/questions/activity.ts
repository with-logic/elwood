/** Private question companion events, kept outside the public API (PRD §4). */
import type { ElwoodActivityEvent } from "../activity/index.ts";
import type { ElwoodQuestionEvent } from "./types.ts";

export type QuestionActivityEvent = Omit<ElwoodActivityEvent, "kind" | "label" | "source"> & {
  readonly source: "terminal";
  readonly kind: "question";
  readonly label: ElwoodQuestionEvent["phase"];
  readonly question: ElwoodQuestionEvent;
};
