/**
 * Unit tests for the shared session-less model-listing probe.
 * Covers PRD §5.3 and C-API-41 teardown/cleanup/error semantics.
 */

import { describe, expect, test, vi } from "vitest";
import type { ElwoodAgentSession } from "../../src/core/agent-session.ts";
import { type ListModelsOptions, probeModels } from "../../src/core/models/list.ts";
import type { AgentModelOption } from "../../src/core/models/rows.ts";

const opts: ListModelsOptions = { cwd: "/tmp/x" };
const rows: readonly AgentModelOption[] = [
  { id: "a", label: "A", isCurrent: true, isDefault: true, raw: "1. A" },
];

// The probe surface the fake satisfies, derived from the real session contract.
type Probe = Pick<ElwoodAgentSession, "waitForStatus" | "listModels" | "teardown">;

type Harness = {
  probe: Probe;
  teardowns: number;
  removals: number;
  timeout: number | undefined;
};

function harness(over: Partial<Probe> = {}): Harness {
  const h: Harness = { teardowns: 0, removals: 0, timeout: undefined, probe: {} as Probe };
  h.probe = {
    waitForStatus: () => Promise.resolve("ready"),
    listModels: (o?: { readonly timeoutMs?: number }) => {
      h.timeout = o?.timeoutMs;
      return Promise.resolve(rows);
    },
    teardown: () => {
      h.teardowns += 1;
      return Promise.resolve();
    },
    ...over,
  };
  return h;
}

/** Build the ProbeAdapter for a harness, counting `removeState` calls. */
function adapterFor(h: Harness, start?: (refuse: (error: Error) => void) => Promise<Probe>) {
  return {
    start: start ?? (() => Promise.resolve(h.probe)),
    removeState: () => {
      h.removals += 1;
    },
  };
}

/** Await a probe and return the Error it rejects with (fails if it resolves). */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the probe to reject");
}

describe("probeModels", () => {
  test("C-API-41 lists, forwards the timeout, tears down, and sweeps state exactly once", async () => {
    const h = harness();
    const result = await probeModels(adapterFor(h), { ...opts, timeoutMs: 1_234 });
    expect(result).toEqual(rows);
    expect(h.timeout).toBe(1_234);
    expect(h.teardowns).toBe(1);
    expect(h.removals).toBe(1);
  });

  test("C-API-41 omits the timeout when unset, passing undefined to listModels", async () => {
    const h = harness();
    await probeModels(adapterFor(h), opts);
    expect(h.timeout).toBeUndefined();
  });

  test("C-API-41 a clean run surfaces a genuine teardown failure but still sweeps state", async () => {
    const h = harness({ teardown: () => Promise.reject(new Error("teardown failed")) });
    await expect(probeModels(adapterFor(h), opts)).rejects.toThrow("teardown failed");
    expect(h.removals).toBe(1); // state is swept in the finally even on teardown failure
  });

  test("C-API-41 a list failure is surfaced; a failing teardown is disclosed via cause; state is swept", async () => {
    let tornDown = false;
    const h = harness({
      listModels: () => Promise.reject(new Error("picker failed")),
      teardown: () => {
        tornDown = true;
        // A teardown that can leave a probe process tree alive fails with an errno.
        return Promise.reject(Object.assign(new Error("teardown also failed"), { code: "EPERM" }));
      },
    });
    // The PRIMARY error is still the picker failure — teardown never masks it...
    const error = await rejectionOf(probeModels(adapterFor(h), opts));
    expect(error.message).toBe("picker failed");
    // ...but the teardown failure is no longer invisible: a bounded diagnostic
    // (allowlisted errno, never a raw message) is attached to the error's cause.
    expect(error.cause).toBe("probe_teardown_failed:EPERM");
    expect(tornDown).toBe(true);
    expect(h.removals).toBe(1);
  });

  test("C-API-41 a list failure with a CLEAN teardown surfaces no teardown diagnostic", async () => {
    const h = harness({ listModels: () => Promise.reject(new Error("picker failed")) });
    // When teardown succeeds on the error path, the primary error carries no cause.
    const error = await rejectionOf(probeModels(adapterFor(h), opts));
    expect(error.message).toBe("picker failed");
    expect(error.cause).toBeUndefined();
    expect(h.teardowns).toBe(1);
  });

  test("C-API-41 a non-errno teardown failure is disclosed by the error's name", async () => {
    const h = harness({
      listModels: () => Promise.reject(new Error("picker failed")),
      // A teardown failure without an errno falls back to the error's bounded name.
      teardown: () => Promise.reject(new TypeError("bad teardown")),
    });
    const error = await rejectionOf(probeModels(adapterFor(h), opts));
    expect(error.cause).toBe("probe_teardown_failed:TypeError");
  });

  test("C-API-41 an existing primary cause is never clobbered by the teardown diagnostic", async () => {
    const h = harness({
      // The primary error already carries a specific cause the caller should keep.
      listModels: () =>
        Promise.reject(Object.assign(new Error("picker failed"), { cause: "orig" })),
      teardown: () => Promise.reject(Object.assign(new Error("teardown"), { code: "EPERM" })),
    });
    const error = await rejectionOf(probeModels(adapterFor(h), opts));
    expect(error.cause).toBe("orig");
  });

  test("C-API-41 a start failure removes any allocated state before rethrowing", async () => {
    const h = harness();
    await expect(
      probeModels(
        adapterFor(h, () => Promise.reject(new Error("start failed"))),
        opts,
      ),
    ).rejects.toThrow("start failed");
    // A start failure can allocate a state dir before rejecting, so removeState
    // MUST run even though no session was returned (C-API-41).
    expect(h.removals).toBe(1);
    expect(h.teardowns).toBe(0);
  });

  test("C-CLAUDE-26 a refusal during start ends the probe without waiting for readiness", async () => {
    const h = harness({ waitForStatus: () => new Promise(() => undefined) });
    const refusal = new Error("refused");
    const start = (refuse: (error: Error) => void) => {
      refuse(refusal);
      return Promise.resolve(h.probe);
    };
    expect(await rejectionOf(probeModels(adapterFor(h, start), opts))).toBe(refusal);
    expect(h.teardowns).toBe(1);
    expect(h.removals).toBe(1);
  });

  test("C-CLAUDE-26 a refusal while waiting for readiness tears the probe down", async () => {
    let waiting = false;
    const h = harness({
      waitForStatus: () => {
        waiting = true;
        return new Promise(() => undefined);
      },
    });
    const refusal = new Error("refused");
    let refuse: (error: Error) => void = () => {
      throw new Error("the probe never received its refusal");
    };
    const start = (received: (error: Error) => void) => {
      refuse = received;
      return Promise.resolve(h.probe);
    };
    const probe = probeModels(adapterFor(h, start), opts);
    await vi.waitFor(() => expect(waiting).toBe(true));
    refuse(refusal);
    expect(await rejectionOf(probe)).toBe(refusal);
    expect(h.teardowns).toBe(1);
    expect(h.removals).toBe(1);
  });
});
