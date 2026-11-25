/**
 * Resume readiness needs the configured composer, not a composer marker (PRD §5.3,
 * C-API-28). A resumed Codex 0.171.0 paints a `Resuming session…` placeholder composer,
 * then its update offer, whose selected row is `› 1. Update now`. Neither is a dialog to
 * the fact table, and Enter on the offer runs a global installer.
 */

import { expect, test, vi } from "vitest";
import { codexComposerConfigured } from "../../src/codex/screen/clearance.ts";
import { codexScreenFactTable } from "../../src/codex/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const placeholder = capturedFrame("codex-0.171.0/update/resume-placeholder");
const offer = capturedFrame("codex-0.171.0/update/offer-npm");
const skipped = capturedFrame("codex-0.171.0/update/resume-skipped-composer");
const facts = (text: string) => readScreenFacts(codexScreenFactTable, { text, title: "" }).facts;
const codex = (configured = codexComposerConfigured) => ({ configured, onBackstop: () => {} });

test("C-API-28 the captured placeholder and offer carry the composer marker, unconfigured", () => {
  for (const frame of [placeholder, offer]) {
    expect(facts(frame)).toMatchObject({ composer_visible: true, blocking_prompt_visible: false });
    expect(codexComposerConfigured(frame, 100)).toBe(false);
  }
  expect(codexComposerConfigured(skipped, 100)).toBe(true);
});

test("C-API-28 a resume marks ready on the configured composer, not the marker", () => {
  let ready = 0;
  const gate = createReadinessGate(() => ready++, true, codex());
  gate.observeReadinessFrame(facts(placeholder), false, placeholder, 100);
  gate.observeReadinessFrame(facts(offer), false, offer, 100);
  expect(ready).toBe(0);
  expect(gate.isHeld()).toBe(false);
  gate.observeReadinessFrame(facts(skipped), false, skipped, 100);
  expect(ready).toBe(1);
});

test("C-API-28 a resume's deadline also waits out the offer for the configured composer", () => {
  vi.useFakeTimers();
  try {
    let ready = 0;
    const gate = createReadinessGate(() => ready++, true, codex());
    gate.observeReadinessFrame(facts(offer), false, offer, 100);
    gate.ready.armDeadline();
    vi.advanceTimersByTime(59_999);
    gate.observeReadinessFrame(facts(offer), false, offer, 100);
    expect(ready).toBe(0);
    vi.advanceTimersByTime(1);
    expect(gate.isHeld()).toBe(true);
    gate.observeReadinessFrame(facts(skipped), false, skipped, 100);
    expect(ready).toBe(1);
    expect(gate.isHeld()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("C-API-28 a resume checks the configured composer only on unblocked composer frames", () => {
  const configured = vi.fn(codexComposerConfigured);
  const gate = createReadinessGate(() => {}, true, codex(configured));
  const dialog = { ...facts(offer), blocking_prompt_visible: true };
  gate.observeReadinessFrame(dialog, false, offer, 100);
  gate.observeReadinessFrame({ ...facts(offer), composer_visible: false }, false, offer, 100);
  expect(configured).not.toHaveBeenCalled();
  gate.observeReadinessFrame(facts(skipped), false, skipped, 100);
  gate.observeReadinessFrame(facts(skipped), false, skipped, 100); // after readiness: not checked
  expect(configured).toHaveBeenCalledOnce();
});

test("C-API-28 without an adapter predicate a resume marks on the first composer marker", () => {
  let ready = 0;
  const gate = createReadinessGate(() => ready++, true);
  gate.observeReadinessFrame(facts(placeholder), false, placeholder, 100);
  expect(ready).toBe(1);
});
