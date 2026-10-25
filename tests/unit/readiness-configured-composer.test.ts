/**
 * The starvation deadline marks only onto a configured session's composer, and a
 * backstop marks anyway so an unrecognized composer never starves readiness (PRD §5.3,
 * C-API-28). Codex 0.164 paints a boot composer without its model footer before a late
 * directory-trust gate; the footer appears once the session is configured.
 */

import { afterEach, expect, test, vi } from "vitest";
import { codexComposerConfigured } from "../../src/codex/screen/clearance.ts";
import { initialReady } from "../../src/runtime/readiness/initial-ready.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

afterEach(() => vi.useRealTimers());

const boot = capturedFrame("codex-0.164.0/boot/boot-composer");
const configured = capturedFrame("codex-0.164.0/boot/configured-composer");
const idle = { composer_visible: true, working_visible: false, blocking_prompt_visible: false };

test("C-API-28 Codex's boot composer is not configured; its footed composer is", () => {
  expect(codexComposerConfigured(boot)).toBe(false);
  expect(codexComposerConfigured(configured)).toBe(true);
  for (const older of [
    "codex-0.142.5/composer-model-only",
    "codex-0.156.1/cleared-composer",
    "codex-0.159.2/warning-composer",
  ])
    expect(codexComposerConfigured(capturedFrame(older))).toBe(true);
  expect(codexComposerConfigured(configured.replace(/^›.*$/m, ""))).toBe(false);
});

test("C-API-28 a deadline expiring on Codex's boot composer waits for the configured one", () => {
  vi.useFakeTimers();
  let ready = 0;
  const gate = createReadinessGate(() => ready++, false, codexComposerConfigured);
  gate.observeReadinessFrame(idle, false, boot);
  gate.ready.armDeadline();
  vi.advanceTimersByTime(10_500);
  expect(ready).toBe(0);
  gate.observeReadinessFrame(idle, false, boot);
  expect(ready).toBe(0);
  gate.observeReadinessFrame(idle, false, configured);
  expect(ready).toBe(1);
  gate.ready.cancel();
});

test("C-API-28 the configured-composer check runs only while the deadline waits for it", () => {
  vi.useFakeTimers();
  const configuredCheck = vi.fn(codexComposerConfigured);
  const gate = createReadinessGate(() => {}, false, configuredCheck);
  gate.ready.armDeadline();
  gate.observeReadinessFrame(idle, false, boot);
  expect(configuredCheck).not.toHaveBeenCalled();
  vi.advanceTimersByTime(10_000);
  expect(configuredCheck).toHaveBeenCalledOnce();
  gate.observeReadinessFrame(idle, false, configured);
  gate.observeReadinessFrame(idle, false, configured); // after readiness: not checked
  expect(configuredCheck).toHaveBeenCalledTimes(2);
});

test("C-API-28 without an adapter predicate the deadline marks onto any frame", () => {
  vi.useFakeTimers();
  let ready = 0;
  const gate = createReadinessGate(() => ready++, false);
  gate.observeReadinessFrame(idle, false, boot);
  gate.ready.armDeadline();
  vi.advanceTimersByTime(10_000);
  expect(ready).toBe(1);
});

test("C-API-28 by default the backstop marks sixty seconds after the first frame", () => {
  vi.useFakeTimers();
  let ready = 0;
  const gate = createReadinessGate(() => ready++, false, codexComposerConfigured);
  gate.observeReadinessFrame(idle, false, boot);
  gate.ready.armDeadline();
  // Twice the slowest measured trust gate (30.6 s): a shorter default could mark
  // before a gate that is still coming.
  vi.advanceTimersByTime(59_999);
  expect(ready).toBe(0);
  vi.advanceTimersByTime(1);
  expect(ready).toBe(1);
});

test("C-API-28 the backstop marks when no configured composer ever paints", () => {
  vi.useFakeTimers();
  let ready = 0;
  const r = initialReady(
    () => ready++,
    10,
    () => false,
    () => false,
    100,
  );
  r.armDeadline();
  vi.advanceTimersByTime(50);
  expect(ready).toBe(0);
  r.retryWhenReleased(false); // another unconfigured frame
  expect(ready).toBe(0);
  vi.advanceTimersByTime(50);
  expect(ready).toBe(1);
});

test("C-API-28 the readiness hook needs no composer, and readiness arms no timer afterwards", () => {
  vi.useFakeTimers();
  let ready = 0;
  const r = initialReady(
    () => ready++,
    10,
    () => false,
    () => false,
  );
  r.mark();
  expect(ready).toBe(1);
  r.armDeadline();
  expect(vi.getTimerCount()).toBe(0);
});
