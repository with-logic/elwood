/**
 * Exact new/resume session facade for headless CLI execution.
 * Implements PRD §12A.2/§12A.5 and C-CLI-03/C-CLI-04/C-CLI-08/C-CLI-15.
 */

import { randomUUID } from "node:crypto";
import { codexSubmittedPrompt } from "../../codex/submitted-prompt.ts";
import type { ElwoodAgentSession, ElwoodCommonEventMap } from "../../core/agent-session.ts";
import { elwoodError } from "../../core/errors.ts";
import type { TurnEvent } from "../../core/simple/events.ts";
import { SessionBase } from "../../core/simple/session.ts";
import { defaultBoundarySignal } from "../../core/simple/turn.ts";
import type { TurnOptions } from "../../core/simple/turn-types.ts";
import type { ElwoodSessionStatus, TerminalSize, Unsubscribe } from "../../core/types.ts";
import { readPrivateSessionRecord, removeSessionIdentity } from "../../state/private-session.ts";
import type { SessionRecord } from "../../state/store.ts";
import { finalizeRunRequest } from "../request/index.ts";
import type { CliAgent, EffectiveRunRequest, ResolvedRunRequest } from "../types.ts";
import {
  type CliLaunchDependencies,
  createCliLaunch,
  defaultCliLaunchDependencies,
} from "./launch.ts";

export type CliSessionDependencies = {
  readonly randomId: () => string;
  readonly readRecord: (stateDir: string, id: string) => SessionRecord;
  readonly finalize: typeof finalizeRunRequest;
  readonly launch: CliLaunchDependencies;
};

export type PreparedCliSession = {
  readonly request: EffectiveRunRequest;
  readonly session: CliSessionFacade;
};

export interface CliSessionFacade {
  readonly agent: CliAgent;
  readonly id: string;
  readonly resumed: boolean;
  readonly status: ElwoodSessionStatus;
  readonly session: ElwoodAgentSession | undefined;
  start(): Promise<ElwoodAgentSession>;
  setup(): Promise<void>;
  stream(prompt: string, options?: TurnOptions): AsyncGenerator<TurnEvent>;
  send(prompt: string, options?: TurnOptions): Promise<string>;
  on<E extends keyof ElwoodCommonEventMap>(
    event: E,
    handler: (event: ElwoodCommonEventMap[E]) => void,
  ): Unsubscribe;
  interrupt(options?: { readonly timeoutMs?: number }): Promise<void>;
  resize(size: TerminalSize): Promise<void>;
  close(): Promise<void>;
  kill(): Promise<void>;
  teardown(): Promise<void>;
  preservedSessionId(): string | null;
}

const defaults: CliSessionDependencies = {
  randomId: randomUUID,
  readRecord: readPrivateSessionRecord,
  finalize: finalizeRunRequest,
  launch: defaultCliLaunchDependencies,
};

/** Resolve stored identity first, then create one lazy facade for the effective adapter. */
export async function prepareCliSession(
  draft: ResolvedRunRequest,
  dependencies: CliSessionDependencies = defaults,
): Promise<PreparedCliSession> {
  const stored =
    draft.resume === undefined ? undefined : dependencies.readRecord(draft.stateDir, draft.resume);
  const request = await dependencies.finalize(
    draft,
    stored === undefined ? undefined : { agent: stored.adapter, cwd: stored.cwd },
  );
  const id = draft.resume ?? dependencies.randomId();
  const launch = createCliLaunch(request, id, dependencies.launch);
  return { request, session: new HeadlessCliSession(request, id, launch) };
}

export class HeadlessCliSession
  extends SessionBase<ElwoodAgentSession>
  implements CliSessionFacade
{
  readonly agent: CliAgent;
  readonly id: string;
  readonly resumed: boolean;
  private readonly request: EffectiveRunRequest;
  private readonly launchSession: () => Promise<ElwoodAgentSession>;
  private setupPromise: Promise<void> | undefined;
  private pendingLaunch: Promise<ElwoodAgentSession> | undefined;

  constructor(request: EffectiveRunRequest, id: string, launch: () => Promise<ElwoodAgentSession>) {
    super();
    this.request = request;
    if (request.agent === "codex") this.submittedPrompt = codexSubmittedPrompt;
    this.agent = request.agent;
    this.id = id;
    this.resumed = request.resume !== undefined;
    this.launchSession = launch;
  }

  protected readonly readBoundarySignal = defaultBoundarySignal;

  protected launch(): Promise<ElwoodAgentSession> {
    const pending = this.validatedLaunch();
    this.pendingLaunch = pending;
    void pending.then(
      () => this.clearPendingLaunch(),
      () => this.clearPendingLaunch(),
    );
    return pending;
  }

  private async validatedLaunch(): Promise<ElwoodAgentSession> {
    const session = await this.launchSession();
    if (session.elwoodSessionId !== this.id) {
      await session.kill().catch(() => undefined);
      throw elwoodError("state_corrupt", "Started session identity did not match its owner.");
    }
    return session;
  }

  setup(): Promise<void> {
    this.setupPromise ??= this.performSetup();
    return this.setupPromise;
  }

  on<E extends keyof ElwoodCommonEventMap>(
    event: E,
    handler: (event: ElwoodCommonEventMap[E]) => void,
  ): Unsubscribe {
    return this.subscribe(event, handler, (session) => session.on(event, handler));
  }

  override teardown(): Promise<void> {
    const live = this.session;
    if (live !== undefined) return live.teardown();
    this.deferPendingCleanup("teardown");
    return Promise.resolve().then(() => {
      removeSessionIdentity(this.request.stateDir, this.id, this.agent);
    });
  }

  override close(): Promise<void> {
    const live = this.session;
    if (live !== undefined) return this.closeLiveSession(live);
    if (this.pendingLaunch !== undefined && this.preservedSessionId() === null) {
      return this.teardown();
    }
    this.deferPendingCleanup("close");
    return Promise.resolve();
  }

  preservedSessionId(): string | null {
    try {
      const record = readPrivateSessionRecord(this.request.stateDir, this.id);
      if (record.adapter !== this.agent || !record[record.adapter].resumeId) return null;
      return this.id;
    } catch {
      return null;
    }
  }

  private async performSetup(): Promise<void> {
    await this.start();
    if (this.resumed && this.request.model !== undefined) await this.setModel(this.request.model);
    if (!this.resumed && this.request.persona !== undefined) {
      await this.send(this.request.persona);
    }
  }

  private clearPendingLaunch(): void {
    this.pendingLaunch = undefined;
  }

  private deferPendingCleanup(action: "close" | "teardown"): void {
    if (this.pendingLaunch === undefined) return;
    void this.start().then(
      async (live) => {
        await (action === "teardown" ? live.teardown() : this.closeLiveSession(live)).catch(
          () => undefined,
        );
      },
      () => {
        if (action === "teardown") this.removeIdentityAfterFailedLaunch();
      },
    );
  }

  private removeIdentityAfterFailedLaunch(): void {
    try {
      removeSessionIdentity(this.request.stateDir, this.id, this.agent);
    } catch {
      // The synchronous cleanup already reported its failure; this late retry is best-effort.
    }
  }
}
