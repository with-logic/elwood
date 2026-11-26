/**
 * Each step of a frame refresh runs even when an earlier one throws, and the refresh
 * reports the failure instead of throwing (PRD §5.4, C-API-72).
 */
import { afterEach, expect, test, vi } from "vitest";
import { claudeScreenFactTable, claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { AttentionWatcher } from "../../src/core/attention.ts";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import type { ElwoodSessionStatus, ElwoodStatusDecision } from "../../src/core/types.ts";
import { createSessionFrameObserver } from "../../src/runtime/session/frames.ts";
import { createReadinessGate, type ReadinessGate } from "../../src/runtime/session/readiness.ts";
import type { StatusEvidenceKind } from "../../src/runtime/status-evidence.ts";
import { claudeComposer } from "../fixtures/trust-composer.ts";

// Observing a frame arms the readiness deadline, which a failed assertion would leave running.
const gates: ReadinessGate[] = [];
afterEach(() => {
  for (const gate of gates.splice(0)) gate.ready.cancel();
});

const dialog = "Do you want to create elwood.txt?\n ❯ 1. Yes\n   3. No\n Esc to cancel";

/** A session whose first `failing` evidence throws before its status changes. */
function harness(failing: StatusEvidenceKind, status: ElwoodSessionStatus) {
  const submitted: StatusEvidenceKind[] = [];
  const warnings: unknown[] = [];
  const active = {
    closing: new AbortController(),
    inputBlocking: false,
    automationInputBlocking: false,
    status,
    submitEvidence(kind: StatusEvidenceKind): ElwoodStatusDecision {
      submitted.push(kind);
      if (kind === failing && submitted.indexOf(kind) === submitted.length - 1)
        throw new Error("observer failure");
      const from = active.status;
      if (kind === "blocking_prompt_shown") active.status = "blocked";
      if (kind === "blocking_prompt_cleared") active.status = "ready";
      return { evidence: kind, from, to: active.status, reason: "test" };
    },
  };
  const automation = { inputBlocking: false, blockedPrompt: undefined, dispose() {} };
  const readiness = createReadinessGate(() => {}, false);
  gates.push(readiness);
  const observedByReadiness = vi.spyOn(readiness, "observeReadinessFrame");
  const frames = createSessionFrameObserver(
    {
      turn: new TurnStateWatcher(),
      attention: new AttentionWatcher(),
      table: claudeScreenFactTable,
      agent: "claude",
      elwoodSessionId: "test",
      emitActivity() {},
      warnings: {
        emit: (name: string, event: unknown) => name === "warning" && warnings.push(event),
      },
    },
    () => active,
    () => automation,
    readiness,
    claudeTrustClearance,
  );
  const observe = (text: string) => frames.observe({ text, title: "" });
  return { active, automation, submitted, warnings, observedByReadiness, observe };
}

test("C-API-72 readiness observes a frame whose blocking evidence throws, and one warning reports it", async () => {
  const { submitted, warnings, observedByReadiness, observe } = harness(
    "blocking_prompt_shown",
    "ready",
  );
  expect(() => observe(dialog)).not.toThrow();
  expect(submitted).toEqual(["blocking_prompt_shown"]);
  expect(observedByReadiness).toHaveBeenCalledOnce();
  expect(observedByReadiness.mock.calls[0]?.[0]).toMatchObject({ blocking_prompt_visible: true });
  // The warning is delivered after the frame.
  expect(warnings).toEqual([]);
  await Promise.resolve();
  expect(warnings).toMatchObject([{ code: "frame_observer_failed", agent: "claude" }]);
});

test("C-API-72 the automation clearance replay runs after a throwing attention step", () => {
  const { active, automation, submitted, observe } = harness("blocking_prompt_cleared", "blocked");
  // Automation owns the dialog, then releases it on a frame that shows the composer.
  automation.inputBlocking = true;
  observe(dialog);
  automation.inputBlocking = false;
  observe(claudeComposer);
  // The attention step's clearance threw; the replay submitted it again.
  expect(submitted.filter((kind) => kind === "blocking_prompt_cleared")).toHaveLength(2);
  expect(active.status).toBe("ready");
});
