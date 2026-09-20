/** Binds one session's lifecycle callbacks to coordinated shutdown (PRD §9.4). */

import type { ElwoodSessionStatus } from "../../core/types.ts";
import type { PtyProcess } from "../../pty/types.ts";
import type { SessionRuntime } from "../../state/runtime-paths.ts";
import { ShutdownCoordinator } from "../shutdown/coordinator.ts";
import type { StatusEvidenceKind } from "../status-evidence.ts";
import type { SessionLoops } from "./loops.ts";
import type { SessionReapPolicy } from "./reap.ts";
import { managedShutdown, type ShutdownEvidence } from "./shutdown.ts";

type ShutdownBindingInput = {
  readonly pty: PtyProcess;
  readonly stateDir: string;
  readonly runtime: SessionRuntime;
  readonly reapPolicy: SessionReapPolicy;
  readonly loops: SessionLoops;
  readonly elwoodSessionId: () => string;
  readonly status: () => ElwoodSessionStatus;
  readonly cleanupRuntime: () => Promise<void>;
  readonly submitEvidence: (kind: StatusEvidenceKind) => void;
};

export class SessionShutdownBinding {
  private pending: ShutdownEvidence | undefined;
  private readonly managed: ReturnType<typeof managedShutdown>;
  private observedExit: Promise<void> | undefined;
  private finishExit: (() => void) | undefined;

  constructor(input: ShutdownBindingInput) {
    this.managed = managedShutdown(new ShutdownCoordinator(), () => ({
      pty: input.pty,
      stateDir: input.stateDir,
      elwoodSessionId: input.elwoodSessionId(),
      socketHome: input.runtime.socketHome,
      reapPolicy: input.reapPolicy,
      status: input.status,
      claimShutdown: (evidence) => {
        this.pending ??= evidence;
      },
      pauseLoops: () => input.loops.pause(),
      clearLoops: async (reason) => input.loops.clear(reason),
      cleanupRuntime: input.cleanupRuntime,
      submitEvidence: input.submitEvidence,
    }));
  }

  stop(): Promise<void> {
    return this.afterObservedExit(this.managed.stop);
  }

  kill(): Promise<void> {
    return this.afterObservedExit(this.managed.kill);
  }

  teardown(): Promise<void> {
    return this.afterObservedExit(this.managed.teardown);
  }

  /** Join natural-exit finalization before any reentrant shutdown can signal or clean up. */
  observeExit(): void {
    this.observedExit = new Promise((resolve) => {
      this.finishExit = resolve;
    });
  }

  completeExit(): void {
    this.finishExit?.();
  }

  private afterObservedExit(work: () => Promise<void>): Promise<void> {
    return this.observedExit ? this.observedExit.then(work) : work();
  }

  exitEvidence(): ShutdownEvidence | "terminal_exited" {
    return this.pending ?? "terminal_exited";
  }
}
