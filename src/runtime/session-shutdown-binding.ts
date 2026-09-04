/** Binds one session's lifecycle callbacks to coordinated shutdown (PRD §9.4). */

import type { PtyProcess } from "../pty/types.ts";
import type { SessionRuntime } from "../state/runtime-paths.ts";
import type { SessionLoops } from "./session-loops.ts";
import type { SessionReapPolicy } from "./session-reap.ts";
import { managedShutdown, type ShutdownEvidence } from "./session-shutdown.ts";
import { ShutdownCoordinator } from "./shutdown-coordinator.ts";
import type { StatusEvidenceKind } from "./status-evidence.ts";

type ShutdownBindingInput = {
  readonly pty: PtyProcess;
  readonly stateDir: string;
  readonly runtime: SessionRuntime;
  readonly reapPolicy: SessionReapPolicy;
  readonly loops: SessionLoops;
  readonly elwoodSessionId: () => string;
  readonly status: () => import("../core/types.ts").ElwoodSessionStatus;
  readonly cleanupRuntime: () => Promise<void>;
  readonly submitEvidence: (kind: StatusEvidenceKind) => void;
};

export class SessionShutdownBinding {
  private pending: ShutdownEvidence | undefined;
  private readonly managed: ReturnType<typeof managedShutdown>;

  constructor(input: ShutdownBindingInput) {
    this.managed = managedShutdown(new ShutdownCoordinator(), () => ({
      pty: input.pty,
      stateDir: input.stateDir,
      elwoodSessionId: input.elwoodSessionId(),
      socketPath: input.runtime.socketPath,
      reapPolicy: input.reapPolicy,
      status: input.status,
      claimShutdown: (evidence) => {
        this.pending ??= evidence;
      },
      clearLoops: async (reason) => input.loops.clear(reason),
      cleanupRuntime: input.cleanupRuntime,
      submitEvidence: input.submitEvidence,
    }));
  }

  stop(): Promise<void> {
    return this.managed.stop();
  }

  kill(): Promise<void> {
    return this.managed.kill();
  }

  teardown(): Promise<void> {
    return this.managed.teardown();
  }

  exitEvidence(): ShutdownEvidence | "terminal_exited" {
    return this.pending ?? "terminal_exited";
  }
}
