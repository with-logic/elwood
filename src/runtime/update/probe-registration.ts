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
  private callbackSettled = false;
  constructor(registrar: Registrar) {
    this.registrar = registrar;
  }

  run<T>(action: () => Promise<T>): Promise<T> {
    return context.run(this, action).finally(() => {
      this.callbackSettled = true;
    });
  }

  register(processGroupId: number, signal: AbortSignal): Promise<void> {
    // The lease is now being released or marked for cleanup. An active record
    // written from here on would replace that final state, so the gate stays closed.
    if (this.callbackSettled)
      return Promise.reject(new Error("The update callback has already settled."));
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

  /**
   * Exited leaders may leave updater descendants in any registered group. An
   * aborted probe's unresolved group is re-observed too: only a group still
   * live after the window keeps the lease.
   */
  unfinishedGroups(abortedGroupId?: number): Promise<readonly number[]> {
    const observedGroupIds = new Set(abortedGroupId === undefined ? [] : [abortedGroupId]);
    for (const id of this.processGroupIds) observedGroupIds.add(id);
    return waitForProbeGroups([...observedGroupIds]);
  }

  /**
   * Orders the lease's final write (release or cleanup record) after every
   * in-flight registration, whose late active record would otherwise replace it.
   * Pending I/O never prolongs caller shutdown.
   */
  afterRegistrationsSettle(action: () => Promise<void>): Promise<void> {
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
