/**
 * Carries an update lease's probe registrar across asynchronous preflight calls.
 * Implements PRD §9.2 / C-PERF-04: persist a process group before opening its gate.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Registrar = (pid: number, signal: AbortSignal) => Promise<void>;
const context = new AsyncLocalStorage<ProbeRegistration>();

export class ProbeRegistration {
  private readonly pending = new Set<Promise<void>>();
  private readonly registrar: Registrar;
  constructor(registrar: Registrar) {
    this.registrar = registrar;
  }

  run<T>(action: () => Promise<T>): Promise<T> {
    return context.run(this, action);
  }

  register(pid: number, signal: AbortSignal): Promise<void> {
    const operation = this.registrar(pid, signal);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  /** Late filesystem completion still owns this lease, never a successor's path. */
  release(action: () => Promise<void>): Promise<void> {
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
