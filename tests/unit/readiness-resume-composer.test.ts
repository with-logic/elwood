/**
 * Resume readiness needs the configured composer, not a composer marker (PRD §5.3,
 * C-API-28). A resumed Codex 0.171.0 paints a `Resuming session…` placeholder composer
 * before anything else. A startup screen Elwood does not recognize can also start a row
 * with the marker, as the selected row of a menu. Neither is a dialog to the fact table.
 */

import { expect, test, vi } from "vitest";
import { codexReadinessEvidence } from "../../src/codex/screen/clearance.ts";
import { codexScreenFactTable } from "../../src/codex/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";
import { unrecognizedStartupScreen as unrecognized } from "../fixtures/codex-unrecognized-startup.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const placeholder = capturedFrame("codex-0.171.0/update/resume-placeholder");
const skipped = capturedFrame("codex-0.171.0/update/resume-skipped-composer");
const facts = (text: string) => readScreenFacts(codexScreenFactTable, { text, title: "" }).facts;
const codex = (configured = codexReadinessEvidence) => ({ configured, onBackstop: () => {} });

test.each([
  ["placeholder", placeholder],
  ["unrecognized startup screen", unrecognized],
])("C-API-28 the %s carries the composer marker, unconfigured", (_name, frame) => {
  expect(facts(frame)).toMatchObject({ composer_visible: true, blocking_prompt_visible: false });
  expect(codexReadinessEvidence(frame, 100)).toBe(false);
});

test("C-API-28 the captured composer after the skip is configured", () => {
  expect(codexReadinessEvidence(skipped, 100)).toBe(true);
});

test("C-API-28 a resume marks ready on the configured composer, not the marker", () => {
  let ready = 0;
  const gate = createReadinessGate(() => ready++, true, codex());
  gate.observeReadinessFrame(facts(placeholder), false, placeholder, 100);
  gate.observeReadinessFrame(facts(unrecognized), false, unrecognized, 100);
  expect(ready).toBe(0);
  expect(gate.holdsReadiness()).toBe(false);
  gate.observeReadinessFrame(facts(skipped), false, skipped, 100);
  expect(ready).toBe(1);
});

test("C-API-28 a resume's deadline also waits out an unrecognized screen for the configured composer", () => {
  vi.useFakeTimers();
  try {
    let ready = 0;
    const gate = createReadinessGate(() => ready++, true, codex());
    gate.observeReadinessFrame(facts(unrecognized), false, unrecognized, 100);
    gate.ready.armDeadline();
    vi.advanceTimersByTime(59_999);
    gate.observeReadinessFrame(facts(unrecognized), false, unrecognized, 100);
    expect(ready).toBe(0);
    vi.advanceTimersByTime(1);
    expect(gate.holdsReadiness()).toBe(true);
    gate.observeReadinessFrame(facts(skipped), false, skipped, 100);
    expect(ready).toBe(1);
    expect(gate.holdsReadiness()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("C-API-28 a resume checks the configured composer only on unblocked composer frames", () => {
  const configured = vi.fn(codexReadinessEvidence);
  const gate = createReadinessGate(() => {}, true, codex(configured));
  const dialog = { ...facts(unrecognized), blocking_prompt_visible: true };
  gate.observeReadinessFrame(dialog, false, unrecognized, 100);
  gate.observeReadinessFrame(
    { ...facts(unrecognized), composer_visible: false },
    false,
    unrecognized,
    100,
  );
  expect(configured).not.toHaveBeenCalled();
  gate.observeReadinessFrame(facts(skipped), false, skipped, 100);
  gate.observeReadinessFrame(facts(skipped), false, skipped, 100); // after readiness: not checked
  expect(configured).toHaveBeenCalledOnce();
});

test("C-API-28 a resume whose ready listener throws retries on the next configured frame", () => {
  const onReady = vi.fn().mockImplementationOnce(() => {
    throw new Error("listener failed");
  });
  const gate = createReadinessGate(onReady, true, codex());
  expect(() => gate.observeReadinessFrame(facts(skipped), false, skipped, 100)).toThrow(
    "listener failed",
  );
  gate.observeReadinessFrame(facts(skipped), false, skipped, 100);
  expect(onReady).toHaveBeenCalledTimes(2);
});
