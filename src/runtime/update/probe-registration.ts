/**
 * Carries an update lease's probe registrar across asynchronous preflight calls.
 * Implements PRD §9.2 / C-PERF-04: persist a process group before opening its gate.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { processGroupGone, waitForProbeGroups } from "../probe-cleanup.ts";

type Registrar = (processGroupIds: readonly number[], signal: AbortSignal) => Promise<void>;
const context = new AsyncLocalStorage<ProbeRegistration>();

export class ProbeRegistration {
  private readonly pending = new Set<Promise<void>>();
  private readonly registrar: Registrar;
  // Every probe of the callback, not only the latest: an earlier probe's
  // descendants must keep exclusion while a later probe runs or after it exits.
  private readonly processGroupIds = new Set<number>();
  constructor(registrar: Registrar) {
    this.registrar = registrar;
  }

  run<T>(action: () => Promise<T>): Promise<T> {
    return context.run(this, action);
  }

  register(processGroupId: number, signal: AbortSignal): Promise<void> {
    for (const id of this.processGroupIds)
      if (processGroupGone(id)) this.processGroupIds.delete(id);
    this.processGroupIds.add(processGroupId);
    const operation = this.registrar([...this.processGroupIds], signal);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  /** Exited leaders may leave updater descendants in any registered group. */
  unfinishedGroups(): Promise<readonly number[]> {
    return waitForProbeGroups([...this.processGroupIds]);
  }

  /** Defers lease release past late registration; pending I/O never prolongs caller shutdown. */
  releaseWhenRegistrationsSettle(action: () => Promise<void>): Promise<void> {
    if (this.pending.size === 0) return action();
    void Promise.allSettled([...this.pending])
      .then(action)
      .catch(() => undefined);
    return Promise.resolve();
  }
}

export function currentProbeRegistration(): ProbeRegistration | undefined {
  return context.getStore();
}
