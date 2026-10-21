/** Production Codex answer routes over captured native frames (PRD §4). */
import { payloadOf, questionCall } from "../../../src/codex/questions/records.ts";
import { reply } from "./acceptance-helpers.ts";
import { harness } from "./adapter-helpers.ts";
import { notesFrame } from "./editor-fixtures.ts";
import { captured, records, scriptedIo } from "./helpers.ts";

export function answerRoute(queued: boolean) {
  const h = harness();
  const native = records(queued ? "async-records.json" : "blocking-records.json")[queued ? 1 : 0];
  h.observe(native);
  const payload = payloadOf(native);
  const call = payload && questionCall(payload);
  if (!call) throw new Error("Missing captured native call");
  const first = captured(queued ? "async-editor-first.txt" : "blocking-modal-first.txt");
  h.adapter.render(first);
  const request = h.registry.list()[0];
  if (!request) throw new Error("Native route did not publish");
  const key = h.registry.keyFor(request.id);
  if (!key) throw new Error("Missing native route identity");
  const second = captured("blocking-modal-second.txt");
  const transitions = queued
    ? [{ input: "\r" }]
    : [
        { input: "\t", next: notesFrame(first) },
        { input: "\r", next: second },
        { input: "\t", next: notesFrame(second) },
        { input: "\r" },
      ];
  const script = () => scriptedIo(first, transitions);
  const acknowledge = (value: string) => {
    if (queued) return h.adapter.observe(reply(key, value));
    return h.observe({
      payload: {
        type: "function_call_output",
        call_id: call.callId,
        output: JSON.stringify({
          answers: { color: { answers: [value] }, note: { answers: ["Standard"] } },
        }),
      },
    });
  };
  return {
    ...h,
    request,
    script,
    acknowledge,
    answers: request.questions.map(() => ({ optionIndexes: [0] })),
  };
}
