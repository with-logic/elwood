/** Private owned-answer lifecycle fixtures for PRD §4. */
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { call, event, setup } from "./candidate-helpers.ts";

export function owned(queued = true) {
  const context = setup();
  context.state.observe(event(call({ id: "call", queued, accepted: queued })));
  const candidate = [...context.state.candidates.values()][0]!;
  const events: ElwoodQuestionEvent[] = [];
  context.registry.onEvent((edge) => events.push(edge));
  context.state.publish(candidate);
  const controller = new AbortController();
  const reason = () => events.at(-1);
  return { ...context, candidate, controller, reason };
}
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
export function output(answers: unknown) {
  return event({
    type: "function_call_output",
    call_id: "call",
    output: JSON.stringify({ answers }),
  });
}
