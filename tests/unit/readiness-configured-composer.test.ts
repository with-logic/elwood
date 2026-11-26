/**
 * The deadline requires a configured composer; the backstop warns while retaining
 * queued input (PRD §5.3, C-API-28). Codex 0.164 paints a boot composer without its model footer before a late
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
const dialog = { ...idle, blocking_prompt_visible: true };
const codex = (configured = codexComposerConfigured, onBackstop = () => {}) => ({
  configured,
  onBackstop,
});

test("C-API-28 Codex's boot composer is not configured; its footed composer is", () => {
  expect(codexComposerConfigured(boot)).toBe(false);
  expect(codexComposerConfigured(configured)).toBe(true);
  expect(codexComposerConfigured(configured.replace(/^›.*$/m, ""))).toBe(false);
});

test.each([
  "codex-0.142.5/composer-model-only",
  "codex-0.156.1/cleared-composer",
  "codex-0.159.2/warning-composer",
  "codex-0.170.0/xhigh-fast-composer",
  "codex-0.170.0/effort-only-composer",
])("C-API-28 captured %s is configured", (capture) => {
  expect(codexComposerConfigured(capturedFrame(capture))).toBe(true);
});

test("C-API-28 a deadline expiring on Codex's boot composer waits for the configured one", () => {
  vi.useFakeTimers();
  let ready = 0;
  const gate = createReadinessGate(() => ready++, false, codex());
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
  const gate = createReadinessGate(() => {}, false, codex(configuredCheck));
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

test("C-API-28 the backstop warns at sixty seconds without releasing readiness", () => {
  vi.useFakeTimers();
  let ready = 0;
  const reported = vi.fn();
  const gate = createReadinessGate(() => ready++, false, codex(codexComposerConfigured, reported));
  gate.observeReadinessFrame(idle, false, boot);
  gate.ready.armDeadline();
  vi.advanceTimersByTime(59_999);
  expect(ready).toBe(0);
  vi.advanceTimersByTime(1);
  expect(ready).toBe(0);
  expect(reported).toHaveBeenCalledOnce();
  gate.observeReadinessFrame(idle, false, configured);
  expect(ready).toBe(1);
});

test("C-API-28 missing evidence warns even behind a dialog, and later clearance readies", () => {
  vi.useFakeTimers();
  let ready = 0;
  const reported = vi.fn();
  const gate = createReadinessGate(() => ready++, false, codex(codexComposerConfigured, reported));
  gate.observeReadinessFrame(dialog, false, boot); // a dialog holds readiness past the backstop
  gate.ready.armDeadline();
  vi.advanceTimersByTime(60_000);
  expect(ready).toBe(0);
  gate.observeReadinessFrame(idle, false, configured);
  expect(ready).toBe(1);
  expect(reported).toHaveBeenCalledOnce();
});

test("C-API-28 a failing backstop report never releases input or breaks a frame", () => {
  vi.useFakeTimers();
  let ready = 0;
  let held = true;
  const report = vi.fn(() => {
    throw new Error("warning sink");
  });
  const r = initialReady(
    () => ready++,
    10,
    () => held,
    {
      shown: () => false,
      onBackstop: report,
      backstopMs: 100,
    },
  );
  r.armDeadline();
  vi.advanceTimersByTime(100);
  held = false;
  expect(() => r.retryWhenReleased(false)).not.toThrow(); // the dialog clears but configured-composer evidence remains absent
  expect(ready).toBe(0);
  expect(report).toHaveBeenCalledTimes(1);
  r.mark(); // an authoritative hook can still ready after the warning
  expect(ready).toBe(1);
});

test("C-API-28 the backstop retains readiness when no configured composer ever paints", () => {
  vi.useFakeTimers();
  let ready = 0;
  const reported = vi.fn();
  const r = initialReady(
    () => ready++,
    10,
    () => false,
    {
      shown: () => false,
      onBackstop: reported,
      backstopMs: 100,
    },
  );
  r.armDeadline();
  vi.advanceTimersByTime(50);
  expect(ready).toBe(0);
  r.retryWhenReleased(false); // another unconfigured frame
  expect(ready).toBe(0);
  vi.advanceTimersByTime(50);
  expect(ready).toBe(0);
  expect(reported).toHaveBeenCalledOnce();
});

test("C-API-28 the readiness hook needs no composer, and readiness arms no timer afterwards", () => {
  vi.useFakeTimers();
  let ready = 0;
  const reported = vi.fn();
  const r = initialReady(
    () => ready++,
    10,
    () => false,
    {
      shown: () => false,
      onBackstop: reported,
    },
  );
  r.mark();
  expect(ready).toBe(1);
  r.armDeadline();
  expect(vi.getTimerCount()).toBe(0);
  expect(reported).not.toHaveBeenCalled();
});

test("C-API-28 backstop holds sendPrompt until authoritative readiness evidence", () => {
  const callback = vi.fn();
  vi.useFakeTimers();
  const gate = createReadinessGate(callback, false, codex());
  expect(gate.holdsReadiness()).toBe(false);
  gate.observeReadinessFrame(idle, false, boot);
  gate.ready.armDeadline();
  vi.advanceTimersByTime(60_000);
  expect(callback).not.toHaveBeenCalled();
  expect(gate.holdsReadiness()).toBe(true);
  gate.ready.mark(); // an authoritative native hook remains sufficient
  expect(callback).toHaveBeenCalledOnce();
  expect(gate.holdsReadiness()).toBe(false);
});
