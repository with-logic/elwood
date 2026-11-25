/** Verify standalone Claude paste envelope boundaries (C-API-67). */
import { expect, test } from "vitest";
import { claudePromptPresentation } from "../../src/claude/pasted-content.ts";

const id = "0e08";
const body = "first line\nsecond line";
const envelope = (leading: number, trailing: number, closingId = id) =>
  `${"\n".repeat(leading)}<pasted_content id="${id}">\n${body}\n</pasted_content id="${closingId}">${"\n".repeat(trailing)}`;

const supportedCounts = [0, 1, 2].flatMap((leading) =>
  [0, 1, 2].map((trailing) => ({ leading, trailing })),
);

test.each(supportedCounts)("C-API-67 accepts $leading leading and $trailing trailing LFs", ({
  leading,
  trailing,
}) => {
  const prompt = envelope(leading, trailing);
  expect(claudePromptPresentation(prompt, id)).toEqual({
    text: body,
    nativePrompt: prompt,
    promptProvenance: { origin: "unknown", input: "pasted" },
  });
});

test.each([
  { side: "leading", leading: 3, trailing: 0 },
  { side: "trailing", leading: 0, trailing: 3 },
])("C-API-67 preserves the envelope with three $side LFs", ({ leading, trailing }) => {
  const prompt = envelope(leading, trailing);
  expect(claudePromptPresentation(prompt, id)).toEqual({ text: prompt });
});

test("C-API-67 preserves the envelope when the closing ID differs", () => {
  const prompt = envelope(0, 0, "f00d");
  expect(claudePromptPresentation(prompt, id)).toEqual({ text: prompt });
});
