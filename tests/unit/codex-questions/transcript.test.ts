/** Native async question exclusion from final answers (PRD §7A.5). */
import { expect, test } from "vitest";
import { summarizeTranscriptItem } from "../../../src/codex/transcript/summary.ts";
import { records } from "./record-fixtures.ts";

test("C-QUESTION-04 async question metadata cannot become a final assistant reply", () => {
  const captured = records("async-records.json")[1];
  expect(captured).toMatchObject({
    payload: {
      type: "item_completed",
      item: {
        type: "AgentMessage",
        delivery: "async",
        questions: expect.arrayContaining([expect.objectContaining({ title: expect.any(String) })]),
      },
    },
  });
  const async = { delivery: "async", questions: [{ title: "Q" }], phase: "final_answer" };
  expect(
    summarizeTranscriptItem({ payload: { ...async, type: "agent_message", message: "Q" } }),
  ).toEqual({ kind: "other", label: "question" });
  expect(
    summarizeTranscriptItem({
      payload: { ...async, type: "message", role: "assistant", content: "Q" },
    }),
  ).toEqual({ kind: "other", label: "question" });
  expect(summarizeTranscriptItem(captured).kind).toBe("other");
  expect(
    summarizeTranscriptItem({
      payload: { type: "agent_message", phase: "final_answer", message: "Final" },
    }),
  ).toEqual({ kind: "message", label: "assistant", text: "Final" });
});
