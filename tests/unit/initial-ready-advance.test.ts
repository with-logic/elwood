/**
 * The shared anti-starvation initial-ready boundary composed with the REAL status
 * engine (PRD §5.3, C-API-42): when the `ready` transition's persist OR listener
 * throws, the engine has already committed `current = ready`, so a plain retry is a
 * no-op — advanceInitialReady must therefore release the queue DIRECTLY and warn, for
 * BOTH adapters. Reproduces the exact starvation the validator found for Codex.
 */

import { describe, expect, test } from "vitest";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";
import { advanceInitialReady } from "../../src/runtime/initial-ready-advance.ts";
import { SessionStatusEngine } from "../../src/runtime/status-evidence.ts";
import { createSessionRecord } from "../../src/state/store.ts";

const record = createSessionRecord({ stateDir: "/tmp/x", cwd: "/tmp/x", id: "s1" });

/** Build a real engine + advance whose persist/emit fault is injectable. */
function harness(fault: "persist" | "listener", agent: "claude" | "codex") {
  let queueReleased = false;
  const warnings: ElwoodWarningEvent[] = [];
  const engine = new SessionStatusEngine({
    persistStatus: (s) => {
      if (fault === "persist" && s === "ready") throw new Error("persist boom");
    },
    emitStatus: (s) => {
      if (fault === "listener" && s === "ready") throw new Error("listener boom");
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
      record,
      submitInitialReady: () => void engine.submit("initial_ready"),
      persist: () => {
        if (fault === "persist") throw new Error("persist boom"); // the classify probe also faults
      },
      markReady: () => {
        queueReleased = true;
      },
      recordWarnings: (w) => warnings.push(...w),
    });
  return { advance, get: () => ({ queueReleased, warnings }) };
}

describe("C-API-42 advanceInitialReady with the real status engine", () => {
  for (const agent of ["claude", "codex"] as const) {
    test(`${agent}: a READY-PERSIST failure still releases the queue and warns`, () => {
      const h = harness("persist", agent);
      h.advance();
      const { queueReleased, warnings } = h.get();
      expect(queueReleased).toBe(true); // the queue was NOT left starved
      expect(warnings).toMatchObject([
        { code: "initial_ready_fallback", agent, reason: "persist" },
      ]);
    });

    test(`${agent}: a READY-LISTENER failure still releases the queue and warns`, () => {
      const h = harness("listener", agent);
      h.advance();
      const { queueReleased, warnings } = h.get();
      expect(queueReleased).toBe(true);
      expect(warnings).toMatchObject([
        { code: "initial_ready_fallback", agent, reason: "listener" },
      ]);
    });
  }

  test("a clean ready transition releases the queue via the engine, with no warning", () => {
    let released = false;
    const engine = new SessionStatusEngine({
      persistStatus: () => {},
      emitStatus: () => {},
      queueRunning: () => {},
      queueReady: () => {
        released = true;
      },
      queueBlocked: () => {},
      queueClose: () => {},
      cleanup: () => {},
    });
    const warnings: ElwoodWarningEvent[] = [];
    advanceInitialReady({
      agent: "codex",
      elwoodSessionId: "s1",
      record,
      submitInitialReady: () => void engine.submit("initial_ready"),
      persist: () => {},
      markReady: () => {
        released = true;
      },
      recordWarnings: (w) => warnings.push(...w),
    });
    expect(released).toBe(true);
    expect(warnings).toEqual([]); // no fallback on the happy path
  });
});
