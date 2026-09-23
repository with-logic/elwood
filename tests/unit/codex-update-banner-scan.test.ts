/** Every visible update banner participates in contradiction checks (PRD §5.5, C-CODEX-12). */
import { expect, test } from "vitest";
import {
  bannerContradictsAppearance,
  continuationOptionsAreBound,
  emptyUpdateEvidence,
  withUpdateFrameEvidence,
} from "../../src/codex/update/evidence.ts";

const original = "Update available! 0.153.3 -> 0.153.4";
const changed = "Update available! 0.153.4 -> 0.154.0";
const evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), original, true);

test.each([
  `${original}\n${changed}`,
  `${changed}\n${original}`,
  `${original}\n${original}\n${changed}\n${original}`,
])("C-CODEX-12 every changed banner contradicts retained evidence: %s", (frame) => {
  expect(bannerContradictsAppearance(evidence, frame)).toBe(true);
});

test("C-CODEX-12 repeated identical banners remain compatible without phantom options", () => {
  const frame = `${original}\n${original}\n  1. Update now\n  2. Skip`;
  const retained = withUpdateFrameEvidence(emptyUpdateEvidence(), frame, true);
  expect(bannerContradictsAppearance(retained, frame)).toBe(false);
  expect([...retained.boundOptions]).toEqual([
    ["1", "Update now"],
    ["2", "Skip"],
  ]);
  expect(continuationOptionsAreBound(retained, "  2. Skip")).toBe(true);
});
