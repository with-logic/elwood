/**
 * The readiness blocking gate (PRD §5.3, C-API-28): a blocking dialog on screen defers
 * EVERY readiness source — including the starvation DEADLINE — so the queue is never
 * released into the dialog, and readiness fires the moment the dialog clears. Covers
 * the "hold a dialog beyond the deadline" case the resume-readiness review required.
 *
 * Uses `initialReady` directly so the deadline can be short; `createReadinessGate`
 * composes this primitive with the per-frame resume-composer mark (both adapters wire
 * it), and its default deadline is the production 10s.
 */

import { describe, expect, test } from "vitest";
import { initialReady } from "../../src/runtime/readiness/initial-ready.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";

describe("C-API-28 readiness blocking gate + deadline", () => {
  test("a dialog held PAST the deadline does not release readiness until it clears", async () => {
    let ready = 0;
    let blocked = true;
    const r = initialReady(
      () => ready++,
      10,
      () => blocked,
    ); // 10ms deadline
    r.armDeadline();
    // The deadline fires while the dialog is STILL up: it must NOT drain into the dialog.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ready).toBe(0);
    r.retryWhenUnblocked(true); // a redraw, still blocked
    expect(ready).toBe(0);
    // The dialog clears: the deferred deadline-readiness fires now.
    blocked = false;
    r.retryWhenUnblocked(false);
    expect(ready).toBe(1);
    r.retryWhenUnblocked(false); // idempotent
    expect(ready).toBe(1);
  });

  test("with no dialog, the deadline releases readiness normally", async () => {
    let ready = 0;
    const r = initialReady(() => ready++, 10); // never blocked
    r.armDeadline();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ready).toBe(1); // deadline fired: nothing blocked it
  });
});

const facts = (composer_visible: boolean, blocking_prompt_visible = false) => ({
  composer_visible,
  blocking_prompt_visible,
});

describe("C-API-28 createReadinessGate per-frame", () => {
  test("on RESUME the composer marks ready — but NOT while a dialog is up", () => {
    let ready = 0;
    const gate = createReadinessGate(() => ready++, true); // resumed
    gate.observeReadinessFrame(facts(true, true)); // composer caret IS a dialog: no mark
    expect(ready).toBe(0);
    gate.observeReadinessFrame(facts(true, false)); // genuine quiet composer: ready
    expect(ready).toBe(1);
  });

  test("a cold-start frame never marks ready off the composer alone", () => {
    let ready = 0;
    const gate = createReadinessGate(() => ready++, false); // cold start
    gate.observeReadinessFrame(facts(true, false)); // composer is a boot placeholder: no mark
    expect(ready).toBe(0);
  });
});
