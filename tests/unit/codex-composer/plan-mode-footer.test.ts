/** Codex 0.172 draws its Plan-mode badge in front of the warnings badge (C-CODEX-26). */
import { expect, test } from "vitest";
import {
  codexComposerClearance,
  codexComposerConfigured,
} from "../../../src/codex/screen/clearance.ts";
import { codexPlanModeFooters172 } from "../../fixtures/codex-footer-captures-172.ts";

const screen = (rows: readonly string[]) => ["• ELWOOD_MODAL_DONE", "", ...rows].join("\n");
const verdict = (frame: string, cols: number) => [
  codexComposerConfigured(frame, cols),
  codexComposerClearance(frame, { cols }),
];

test.each(
  codexPlanModeFooters172.map((capture) => [capture.cols, capture] as const),
)("C-CODEX-26 reads the Plan-mode footer Codex 0.172 drew at %i columns", (_, { cols, rows }) => {
  expect(verdict(screen(rows), cols)).toEqual([true, true]);
});

const [composer, blank, status] = codexPlanModeFooters172[0]!.rows;
test.each([
  ["a Plan-mode badge with no warnings badge after it", "  ← for agents   Plan mode ·"],
  ["a warnings badge without its `f2`", "  ← for agents   Plan mode · ⚠ 3 warnings"],
  ["another mode in the Plan-mode badge's place", "  ← for agents   Code mode · ⚠ 3 · f2"],
])("C-CODEX-26 refuses %s", (_, hint) => {
  expect(verdict(screen([composer!, blank!, status!, hint]), 140)).toEqual([false, false]);
});
