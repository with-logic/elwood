/** Exact retained-evidence limits and versioned layouts (PRD §5.5, C-CODEX-12). */
import { expect, test } from "vitest";
import {
  continuationOptionsAreBound,
  emptyUpdateEvidence,
  retainedOptionLabelsAgree,
  withUpdateFrameEvidence,
} from "../../src/codex/update/evidence.ts";

const banner = "Update available! 0.153.3 -> 0.153.4";
const choices = "  1. Update now\n  2. Skip\n  3. Skip until next version";

test.each([
  "0.153.3 -> 0.153.4",
  "1.153.3 -> 1.153.4",
])("C-CODEX-12 version banner %s cannot consume an option binding", (versions) => {
  const frame = `Update available! ${versions}\n${choices}`;
  const evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), frame, true);
  expect([...evidence.boundOptions]).toEqual([
    ["1", "Update now"],
    ["2", "Skip"],
    ["3", "Skip until next version"],
  ]);
  expect(retainedOptionLabelsAgree(evidence, frame)).toBe(true);
  expect(continuationOptionsAreBound(evidence, frame)).toBe(true);
  expect(continuationOptionsAreBound(evidence, "  2. Skip\n  3. Skip until next version")).toBe(
    true,
  );
  expect(evidence.overflowed).toBe(false);
});

test.each([32, 33])("C-CODEX-12 retains at most 32 options from a %i-option frame", (count) => {
  const options = Array.from({ length: count }, (_, index) => `  ${index + 1}. Choice`).join("\n");
  const evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), `${banner}\n${options}`, true);
  expect(evidence.boundOptions.size).toBe(32);
  expect(evidence.boundOptions.get("32")).toBe("Choice");
  expect(evidence.boundOptions.has("33")).toBe(false);
  expect(evidence.overflowed).toBe(count === 33);
  expect(continuationOptionsAreBound(evidence, "  32. Choice")).toBe(count === 32);
});

test.each([200, 201])("C-CODEX-12 bounds a %i-character option label", (length) => {
  const label = "x".repeat(length);
  const evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), `  1. ${label}`, true);
  expect(evidence.boundOptions.get("1")).toBe(length === 200 ? label : undefined);
  expect(evidence.overflowed).toBe(length === 201);
  expect(continuationOptionsAreBound(evidence, `  1. ${label}`)).toBe(length === 200);
});

test("C-CODEX-12 an untrusted new number never becomes later continuation evidence", () => {
  const original = withUpdateFrameEvidence(emptyUpdateEvidence(), `${banner}\n${choices}`, true);
  const untrusted = withUpdateFrameEvidence(original, "  4. Skip backup", false);
  expect(untrusted.boundOptions.has("4")).toBe(false);
  const later = withUpdateFrameEvidence(untrusted, `${banner}\n${choices}`, true);
  expect(later.boundOptions.has("4")).toBe(false);
  expect(continuationOptionsAreBound(later, "  4. Skip backup")).toBe(false);
});
