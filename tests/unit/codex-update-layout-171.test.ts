/**
 * Codex 0.171 and later draw the update offer in a new layout, which Elwood recognizes as
 * the same first-party update prompt under every C-CODEX-12 rule (PRD §5.5, C-CODEX-27).
 * The cases are real captures of the npm 0.171.0 and standalone 0.172.0 offers.
 */

import { expect, test } from "vitest";
import { classifyCodexUpdateFrame } from "../../src/codex/update/classification.ts";
import { updateDialogOptions } from "../../src/codex/update/layout.ts";
import { safeUpdateOption } from "../../src/codex/update/selection.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const npmAction = "Update now (runs `npm install -g @openai/codex`)";
const standaloneAction = `Update now (runs \`sh -c 's=$(curl -fsSL https://chatgpt.com/codex/install.sh) && CODEX_NON_INTERACTIVE=1 eval "$s"'\`)`;

test.each([
  ["codex-0.171.0/update/offer-npm", npmAction],
  ["codex-0.171.0/update/offer-npm-60x30", npmAction],
  ["codex-0.172.0/update/offer-standalone-100x30", standaloneAction],
  ["codex-0.172.0/update/offer-standalone-60x30", standaloneAction],
  ["codex-0.172.0/update/offer-standalone-40x30", standaloneAction],
])("C-CODEX-27 the %s capture is a first-party offer whose safe choice is Skip", (capture, action) => {
  const frame = capturedFrame(capture);
  const update = classifyCodexUpdateFrame(frame);
  expect(update).toMatchObject({ hasBanner: true, visible: true, continuation: false });
  const labels = update.options?.map(({ number, label }) => [number, label.replaceAll(" ", "")]);
  expect(labels).toEqual([
    ["1", action.replaceAll(" ", "")],
    ["2", "Skip"],
    ["3", "Skipuntilnextversion"],
  ]);
  expect(safeUpdateOption(frame)?.number).toBe("2");
});

test("C-CODEX-27 the boxed notice Codex prints after a skip is not an update prompt", () => {
  const frame = capturedFrame("codex-0.171.0/update/resume-skipped-composer");
  expect(frame).toContain("Update available!");
  expect(classifyCodexUpdateFrame(frame)).toMatchObject({ hasBanner: false, visible: false });
});

const offer = capturedFrame("codex-0.172.0/update/offer-standalone-60x30");

test.each([
  ["a release-notes link to another page", offer.replace("releases/latest", "releases/tag/x")],
  ["release notes cut short before the choices", offer.replace(/^\s*https:.*\n/m, "")],
  ["a row between the release notes and the choices", offer.replace("\n\n›", "\nRun now?\n›")],
  ["an unknown footer", offer.replace("enter continue · esc skip", "enter continue · esc quit")],
  ["an install command from elsewhere", offer.replace("chatgpt.com/codex/install.sh", "x.sh")],
  ["an unindented command continuation", offer.replace("     chatgpt.com", "chatgpt.com")],
])("C-CODEX-27 %s withholds automation", (_, frame) => {
  expect(updateDialogOptions(frame)).toBeUndefined();
  expect(classifyCodexUpdateFrame(frame)).toMatchObject({ hasBanner: true, visible: true });
  expect(safeUpdateOption(frame)).toBeUndefined();
});
