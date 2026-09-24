/** Admission owns queued cancellation and wraps physical preparation (PRD §5.3/§5.9). */
import { expect, test, vi } from "vitest";
import { ControlAdmissions } from "../../src/core/control-queue/admission.ts";
import type {
  AdmitOperation,
  AroundOperation,
  QueuedOperation,
} from "../../src/core/control-queue/types.ts";

function operation(): QueuedOperation {
  return {
    input: "loop",
    kind: "message",
    mayBypassReadiness: false,
    origin: { kind: "loop", loopId: "loop" },
    resolve: () => undefined,
    reject: () => undefined,
  };
}

test("C-LOOP-08 operations without admission keep their original preparation wrapper", () => {
  const op = operation();
  const wrapper: AroundOperation = (work) => work();
  const admissions = new ControlAdmissions(undefined, vi.fn(), vi.fn());
  expect(admissions.prepare(op)).toBe(true);
  expect(admissions.waiting(op)).toBe(false);
  expect(admissions.takeWrapper(op, wrapper)).toBe(wrapper);
  expect(admissions.takeWrapper(op, undefined)).toBeUndefined();
  admissions.cancel(op, new Error("unused"));
  const declined = new ControlAdmissions(() => undefined, vi.fn(), vi.fn());
  expect(declined.prepare(op)).toBe(true);
  expect(declined.size).toBe(0);
});

test.each([
  false,
  true,
])("C-LOOP-08 admission composes preparation=%s with the active signal and origin", async (prepare) => {
  const op = operation();
  const gate = Promise.withResolvers<void>();
  const wake = vi.fn();
  const events: string[] = [];
  const active = new AbortController();
  const signals: AbortSignal[] = [];
  let queued: AbortSignal | undefined;
  const admit = vi.fn<AdmitOperation>((_origin, signal) => {
    queued = signal;
    return {
      ready: gate.promise,
      run: async (work, actual, origin) => {
        expect(actual).toBe(active.signal);
        expect(origin).toBe(op.origin);
        signals.push(actual);
        events.push("admission");
        await work();
        events.push("settled");
      },
    };
  });
  const admissions = new ControlAdmissions(admit, wake, vi.fn());
  expect(admissions.prepare(op)).toBe(false);
  expect(admissions.prepare(op)).toBe(true);
  expect(admit).toHaveBeenCalledTimes(1);
  expect(admissions.size).toBe(1);
  expect(admissions.has(op)).toBe(true);
  expect(admissions.waiting(op)).toBe(true);
  gate.resolve();
  await gate.promise;
  expect(wake).toHaveBeenCalledOnce();
  expect(admissions.waiting(op)).toBe(false);
  const before: AroundOperation = async (work, signal, origin) => {
    expect(signal).toBe(active.signal);
    expect(origin).toBe(op.origin);
    signals.push(signal);
    events.push("prepare");
    await work();
  };
  const wrapped = admissions.takeWrapper(op, prepare ? before : undefined)!;
  expect(admissions.size).toBe(0);
  await wrapped(
    () => {
      events.push("write");
      return Promise.resolve();
    },
    active.signal,
    op.origin,
  );
  expect(events).toEqual(
    prepare ? ["admission", "prepare", "write", "settled"] : ["admission", "write", "settled"],
  );
  admissions.cancel(op, new Error("already dispatched"));
  expect(queued?.aborted).toBe(false);
  active.abort();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

test.each([
  "resolve",
  "reject",
])("C-LOOP-08 cancelled reservations ignore late readiness %s", async (settlement) => {
  const op = operation();
  const gate = Promise.withResolvers<void>();
  const wake = vi.fn();
  const fail = vi.fn();
  let signal: AbortSignal | undefined;
  const admissions = new ControlAdmissions(
    (_origin, lifetime) => {
      signal = lifetime;
      return { ready: gate.promise, run: (work) => work() };
    },
    wake,
    fail,
  );
  admissions.prepare(op);
  const error = new Error("cancelled");
  admissions.cancel(op, error);
  expect(signal?.aborted).toBe(true);
  expect(signal?.reason).toBe(error);
  expect(admissions.has(op)).toBe(false);
  if (settlement === "resolve") gate.resolve();
  else gate.reject(new Error("late"));
  await gate.promise.catch(() => undefined);
  expect(wake).not.toHaveBeenCalled();
  expect(fail).not.toHaveBeenCalled();
});

test.each([
  "throw",
  "reject",
])("C-LOOP-08 admission %s preserves failure identity and allows a successor", async (mode) => {
  const error = new Error("admission failed");
  const gate = Promise.withResolvers<void>();
  const failed = operation();
  const next = operation();
  let signal: AbortSignal | undefined;
  const failures: unknown[] = [];
  const admissions = new ControlAdmissions(
    (_origin, lifetime) => {
      if (signal) return undefined;
      signal = lifetime;
      if (mode === "throw") throw error;
      return { ready: gate.promise, run: (work) => work() };
    },
    vi.fn(),
    (op, reason) => {
      failures.push([op, reason]);
      admissions.cancel(op, reason);
    },
  );
  expect(admissions.prepare(failed)).toBe(false);
  if (mode === "reject") {
    gate.reject(error);
    await gate.promise.catch(() => undefined);
  }
  expect(signal?.aborted).toBe(true);
  expect(signal?.reason).toBe(error);
  expect(failures).toEqual([[failed, error]]);
  expect(admissions.size).toBe(0);
  expect(admissions.prepare(next)).toBe(true);
});
