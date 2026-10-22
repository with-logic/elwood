/** Captured successor frames for the grouped Claude answer flow (PRD §4). */
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { fixture, frame } from "./helpers.ts";

/** Eight successors for choosing Blue and both features, ending at native review. */
export function groupedAnswerFrames(): readonly QuestionFrame[] {
  const logging = fixture("features-logging");
  const metrics = frame(logging.text.replace("❯ 1.", "  1.").replace("  2. [ ]", "❯ 2. [ ]"));
  const other = frame(
    fixture("features-both").text.replace("❯ 2.", "  2.").replace("  3. [ ]", "❯ 3. [ ]"),
  );
  return [
    fixture("color-blue-highlight"),
    fixture("features-initial"),
    logging,
    metrics,
    fixture("features-both"),
    other,
    fixture("features-submit-highlight"),
    fixture("review"),
  ];
}
