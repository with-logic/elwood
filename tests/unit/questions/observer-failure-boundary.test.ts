/** Diagnose only tagged native adapter observer failures (PRD §5.4, §5.10). */
import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import { QuestionObserverFailure } from "../../../src/core/questions/notification-errors.ts";
import type { ElwoodWarningEvent } from "../../../src/core/types.ts";
import { controllerHarness, disposeTerminals } from "./controller-helpers.ts";
import { definitions } from "./helpers.ts";

afterEach(disposeTerminals);
test.each([
  "observe",
  "render",
] as const)("%s contains plain errors and diagnoses only tagged observer failures", async (boundary) => {
  for (const tagged of [false, true]) {
    const h = controllerHarness({ agent: "codex" });
    const privateCause = new Error("PRIVATE_NATIVE_OBSERVER_FAILURE");
    const failure = tagged ? new QuestionObserverFailure(privateCause) : privateCause;
    const warnings: ElwoodWarningEvent[] = [];
    const warningActivities: ElwoodActivityEvent[] = [];
    const delivered: string[] = [];
    await h.terminal.writeOutput("native panel");
    h.events.on("warning", (event) => warnings.push(event));
    h.events.on("activity", (event) => {
      if (event.kind === "warning") warningActivities.push(event);
      if (event.kind === "hook") delivered.push(event.label);
    });
    const render = vi.fn();
    h.questions.configure((registry) => ({
      ...h.adapter,
      observe: () => {
        if (boundary === "observe") {
          registry.publish("native", "queued", definitions);
          throw failure;
        }
        return true;
      },
      render: (frame) => {
        render(frame);
        if (boundary === "render") {
          registry.publish("native", "queued", definitions);
          throw failure;
        }
      },
    }));
    try {
      expect(() => h.activity()).not.toThrow();
      expect(h.questions.list()).toHaveLength(1);
      expect(render).toHaveBeenCalledOnce();
      expect(() => h.activity("next")).not.toThrow();
      expect(render).toHaveBeenCalledTimes(2);
      expect(delivered).toEqual(["changed", "next"]);
      if (boundary === "render") {
        await expect(h.terminal.writeOutput(" updated")).resolves.toBeUndefined();
        expect(render).toHaveBeenCalledTimes(3);
      }
      expect(h.terminal.renderFailed).toBe(false);
      expect(h.questions.list()).toHaveLength(1);
      expect(h.questions.blocksInput()).toBe(true);
      expect(warnings).toEqual(
        tagged
          ? [
              {
                elwoodSessionId: "s",
                agent: "codex",
                source: "lifecycle",
                code: "question_observer_failed",
                severity: "warning",
                phase: "question",
                message: "A question notification failed; native question ownership was preserved.",
                raw: "question_observer_failed phase=question",
              },
            ]
          : [],
      );
      expect(warningActivities).toEqual(
        tagged
          ? [
              {
                elwoodSessionId: "s",
                agent: "codex",
                source: "lifecycle",
                kind: "warning",
                label: "question_observer_failed",
                text: warnings[0]!.message,
                raw: warnings[0],
              },
            ]
          : [],
      );
      expect(JSON.stringify([warnings, warningActivities])).not.toContain(privateCause.message);
    } finally {
      h.closing.abort();
    }
  }
});
