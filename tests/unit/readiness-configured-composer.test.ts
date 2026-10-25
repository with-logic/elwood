/**
 * The starvation deadline marks only onto a configured session's composer, and a
 * backstop marks anyway so an unrecognized composer never starves readiness (PRD §5.3,
 * C-API-28). Codex 0.164 paints a boot composer without its model footer before a late
 * directory-trust gate; the footer appears once the session is configured.
 */

import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { codexComposerConfigured } from "../../src/codex/screen/clearance.ts";
import { initialReady } from "../../src/runtime/readiness/initial-ready.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";

afterEach(() => vi.useRealTimers());

const fixture = (path: string) =>
  readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8");
const boot = fixture("codex-0.164.0/boot/boot-composer.txt");
const configured = fixture("codex-0.164.0/boot/configured-composer.txt");
const idle = { composer_visible: true, working_visible: false, blocking_prompt_visible: false };

test("C-API-28 Codex's boot composer is not configured; its footed composer is", () => {
  expect(codexComposerConfigured(boot)).toBe(false);
  expect(codexComposerConfigured(configured)).toBe(true);
  for (const older of [
    "codex-0.142.5/composer-model-only.txt",
    "codex-0.156.1/cleared-composer.txt",
    "codex-0.159.2/warning-composer.txt",
  ])
    expect(codexComposerConfigured(fixture(older))).toBe(true);
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

test("C-API-28 without an adapter predicate the deadline marks onto any frame", () => {
  vi.useFakeTimers();
  let ready = 0;
  const gate = createReadinessGate(() => ready++, false);
  gate.observeReadinessFrame(idle, false, boot);
  gate.ready.armDeadline();
  vi.advanceTimersByTime(10_000);
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
