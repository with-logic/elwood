/** Shared complete native queue/editor evidence for private adapter proofs (PRD §4). */
import { editorFrame } from "./editor-fixtures.ts";
import { frame } from "./helpers.ts";
import { snapshot } from "./snapshot-fixtures.ts";

export const queuedCall = (id: string, title: string, isSecret = false) => ({
  payload: { type: "AgentMessage", id, delivery: "async", questions: [{ title, isSecret }] },
});
export function queuedEditor(prompt: string) {
  const native = snapshot("async-after-local-skip.json");
  return editorFrame(frame(native.text.replaceAll("ELWOOD_ASYNC_NOTE: What note?", prompt)), {
    editorLine: "  Type your answer",
    cursorLineBefore: "  ",
    dimmed: true,
  });
}
