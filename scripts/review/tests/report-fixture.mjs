/** Generates complete Markdown evidence using the production lens roster. */
import { lenses } from "../report.mjs";
export function reportFixture(content = {}, verdict = "Verdict: clean, no notes") {
  return `# Review\n${verdict}\n\n## Findings By Dimension\n\n${lenses
    .map((lens) => `### ${lens}\n\n${content[lens] ?? "No findings."}`)
    .join(
      "\n\n",
    )}\n\n## Reviewer Coverage\n\n${lenses.map((lens) => `- ${lens}: completed`).join("\n")}\n`;
}
export const findingFixture = (severity = "minor") => `#### ${severity}: A finding
- Confidence: high
- Location: fixture:1
- Finding: The fixture fails.
- If unfixed: The fixture remains broken.
- Fix: Repair the fixture.
- Fix cost: One line.
`;
