/** Native reply evidence for private Codex answer-correlation tests (PRD §4). */
import { event } from "./candidate-helpers.ts";

export function reply(questionItemId: string, answer: string, extra: readonly unknown[] = []) {
  return event({
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId, answer }, ...extra])}</send_user_message_question_reply>`,
      },
    ],
  });
}
