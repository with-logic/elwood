/** Production driver failure releases temporary native expectations (PRD §4). */
import { expect, test } from "vitest";
import { answerRoute } from "./acceptance-route-helpers.ts";

test.each([
  true,
  false,
])("a failed queued=%s driver releases its expectation for an unwritten retry", async (queued) => {
  const h = answerRoute(queued);
  const scripted = h.script();
  try {
    await expect(
      h.adapter.answer(h.request, h.answers, {
        ...scripted.io,
        write: () => Promise.reject(new Error("native write rejected")),
      }),
    ).rejects.toThrow("native write rejected");
    await h.adapter.answer(h.request, h.answers, scripted.io);
    expect(scripted.writes).toEqual(queued ? ["\r"] : ["\t", "\r", "\t", "\r"]);
    h.acknowledge("Amber");
    expect(h.events.at(-1)).toMatchObject({ phase: "closed", reason: "answered" });
  } finally {
    scripted.controller.abort();
    h.registry.shutdown();
  }
});
