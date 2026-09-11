/**
 * The shared anti-starvation initial-ready boundary composed with the REAL status
 * engine (PRD §5.3, C-API-42): when the `ready` transition's lifecycle listener
 * throws, the engine has already committed `current = ready`, so a plain retry is a
 * no-op — advanceInitialReady must therefore release the queue DIRECTLY and warn, for
 * BOTH adapters. Status is live-only now, so there is no persist failure mode.
 */

import { describe, expect, test } from "vitest";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";
import { advanceInitialReady } from "../../src/runtime/readiness/advance.ts";
import { SessionStatusEngine } from "../../src/runtime/status-evidence.ts";

/** Build a real engine + advance whose ready-listener fault is injectable. */
function harness(faulted: boolean, agent: "claude" | "codex") {
  let queueReleased = false;
  const warnings: ElwoodWarningEvent[] = [];
  const engine = new SessionStatusEngine({
    onReady: () => {},
    emitStatus: (s) => {
      if (faulted && s === "ready") throw new Error("listener boom");
    },
    queueRunning: () => {},
    queueReady: () => {
      queueReleased = true;
    },
    queueBlocked: () => {},
    queueClose: () => {},
    cleanup: () => {},
  });
  const advance = () =>
    advanceInitialReady({
      agent,
      elwoodSessionId: "s1",
      submitInitialReady: () => void engine.submit("initial_ready"),
      markReady: () => {
        queueReleased = true;
      },
      emitWarnings: (w) => warnings.push(...w),
    });
  return { advance, get: () => ({ queueReleased, warnings }) };
}

describe("C-API-42 advanceInitialReady with the real status engine", () => {
  for (const agent of ["claude", "codex"] as const) {
    test(`${agent}: a READY-LISTENER failure still releases the queue and warns`, () => {
      const h = harness(true, agent);
      h.advance();
      const { queueReleased, warnings } = h.get();
      expect(queueReleased).toBe(true); // the queue was NOT left starved
      // The warning is typed, live-only, and content-free: no raw listener error text.
      expect(warnings).toMatchObject([
        {
          code: "initial_ready_fallback",
          agent,
          elwoodSessionId: "s1",
          source: "lifecycle",
          severity: "warning",
          raw: "initial_ready_fallback",
        },
      ]);
      expect(warnings[0]).not.toHaveProperty("reason");
      expect(warnings[0]?.message).not.toContain("boom");
    });
  }

  test("a clean ready transition releases the queue via the engine, with no warning", () => {
    const h = harness(false, "codex");
    h.advance();
    const { queueReleased, warnings } = h.get();
    expect(queueReleased).toBe(true);
    expect(warnings).toEqual([]); // no fallback on the happy path
  });

  test("a throwing warning sink cannot re-starve the released queue", () => {
    let released = false;
    // emitWarnings itself throwing must not block the direct queue release.
    advanceInitialReady({
      agent: "claude",
      elwoodSessionId: "s1",
      submitInitialReady: () => {
        throw new Error("submit boom");
      },
      markReady: () => {
        released = true;
      },
      emitWarnings: () => {
        throw new Error("sink boom");
      },
    });
    expect(released).toBe(true); // released despite the throwing sink
  });
});
