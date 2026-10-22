/** Earlier transcript text cannot authorize a changed native review (PRD §4). */
import { expect, test } from "vitest";
import { answerClaudeQuestions } from "../../../src/claude/questions/answer.ts";
import { definitions, fixture, frame, registry } from "./helpers.ts";
import { scriptedQuestionIo as ioFor } from "./scripted-io-helpers.ts";

test("expected answers quoted above a wrong review never authorize its final Enter", async () => {
  const request = registry().publish("native", "blocking", definitions)!;
  const logging = fixture("features-logging");
  const metrics = frame(logging.text.replace("❯ 1.", "  1.").replace("  2. [ ]", "❯ 2. [ ]"));
  const other = frame(
    fixture("features-both").text.replace("❯ 2.", "  2.").replace("  3. [ ]", "❯ 3. [ ]"),
  );
  const wrong = frame(
    `History quoted: ● Which test color? → Blue\n${fixture("review").text.replace("→ Blue", "→ Amber")}`,
  );
  const { io, writes } = ioFor(fixture("questions"), [
    fixture("color-blue-highlight"),
    fixture("features-initial"),
    logging,
    metrics,
    fixture("features-both"),
    other,
    fixture("features-submit-highlight"),
    wrong,
    fixture("answered"),
  ]);
  await expect(
    answerClaudeQuestions(request, [{ optionIndexes: [1] }, { optionIndexes: [0, 1] }], io),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(writes.filter((key) => key === "\r")).toHaveLength(2);
});
