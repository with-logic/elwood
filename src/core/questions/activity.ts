/** Structured question activity carried by the public event union (PRD §5.10). */
import type { ElwoodActivityEvent } from "../activity/index.ts";
export type QuestionActivityEvent = Extract<ElwoodActivityEvent, { readonly kind: "question" }>;
