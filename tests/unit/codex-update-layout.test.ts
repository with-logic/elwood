/** Strict update classification is independent of live retry policy (PRD §5.5, C-CODEX-12). */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { classifyCodexUpdateFrame } from "../../src/codex/update/classification.ts";
import { updateDialogOptions } from "../../src/codex/update/layout.ts";

const banner = "Update available! 0.153.3 -> 0.153.4";
const choices = "1. Update now\n2. Skip";
const update = `${banner}\n${choices}`;

test.each([
  `2. Skip\nOld transcript\n${banner}\n1. Update now`,
  ...["2.", "› 2.", "1.Update now", "2.Skip", "›1.Update now", ">2.Skip"].map(
    (prefix) => `${prefix}\n${banner}\n2.Skip`,
  ),
  `${update}\n1. Delete archive\n2. Keep archive`,
  `${update}\n${choices}`,
  `${update}\n1. Skip`,
  `${update}\n3. Delete archive`,
  `${banner}\n1. Up\n2. Skip`,
  `${update}\nConfirm archive removal?`,
  `${banner}\nConfirm archive removal?\n${choices}`,
  `${banner}\nUpdate available! 0.153.4 -> 0.154.0\n${choices}`,
  "2. Skip\nConfirm archive removal?",
  "2. Skip\n\nConfirm archive removal?\n3. Later",
  "2. Skip\nPress enter to continue\n3. Later",
  "2. Skip\n    Confirm archive removal?",
  "2. Skip\nPress enter to continue\nConfirm archive removal?",
  `${banner}\n1. Update now (runs \`install |\nConfirm archive removal?\n2. Skip`,
  `${banner}\n1. Update now (runs \`sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh |\n    Confirm archive removal?\n2. Skip`,
  `${banner}\n1. Update now (runs \`sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh |\nCODEX_NON_INTERACTIVE=1 sh'\`)\n2. Skip`,
])("C-CODEX-12 unknown or mixed option blocks have no eligible choices: %s", (frame) => {
  expect(updateDialogOptions(frame)).toBeUndefined();
  expect(classifyCodexUpdateFrame(frame).options).toBeUndefined();
});

test.each([
  "100x30",
  "100x8",
  "100x6",
  "100x3",
])("C-CODEX-12 native Codex 0.155.1 %s captures preserve visible choices", (size) => {
  const frame = readFileSync(
    new URL(`../fixtures/codex-0.155.1/update-${size}.txt`, import.meta.url),
    "utf8",
  );
  const result = classifyCodexUpdateFrame(frame);
  expect(result.hasBanner).toBe(true);
  expect(result.visible).toBe(true);
  expect(result.continuation).toBe(false);
  expect(result.options?.map((option) => option.number)).toEqual(
    size === "100x30"
      ? ["1", "2", "3"]
      : size === "100x8"
        ? ["1", "2"]
        : size === "100x6"
          ? ["1"]
          : [],
  );
});

test("C-CODEX-12 repeated banners, padding, native command and footer preserve one block", () => {
  const frame = `${banner}\n${banner}\n\n1. Update now (runs \`npm install -g @openai/codex\`)\n2. Skip\nPress enter to continue\n `;
  expect(updateDialogOptions(frame)?.map((option) => option.number)).toEqual(["1", "2"]);
  expect(classifyCodexUpdateFrame(banner).options).toEqual([]);
});

test.each([
  [choices, true, true],
  ["2. Skip", false, true],
  ["2. Later", false, false],
  ["1. Update now\n2. Later", true, false],
  ["1. Update now", false, false],
  ["Ordinary output", false, false],
])("C-CODEX-12 option-only visibility and continuation stay distinct: %s", (frame, visible, continuation) => {
  expect(classifyCodexUpdateFrame(frame as string)).toMatchObject({
    hasBanner: false,
    visible,
    continuation,
  });
});
