/**
 * Exact new/resume session facade for headless CLI execution.
 * Implements PRD §12A.2/§12A.5 and C-CLI-03/C-CLI-04/C-CLI-08/C-CLI-15.
 */

import { randomUUID } from "node:crypto";
import type { ElwoodAgentSession, ElwoodCommonEventMap } from "../core/agent-session.ts";
import { elwoodError } from "../core/errors.ts";
import type { TurnEvent } from "../core/simple/events.ts";
import { SessionBase } from "../core/simple/session.ts";
import { defaultBoundarySignal } from "../core/simple/turn.ts";
import type { TurnOptions } from "../core/simple/turn-types.ts";
import type { ElwoodSessionStatus, Unsubscribe } from "../core/types.ts";
import { readPrivateSessionRecord, removeSessionIdentity } from "../state/private-session.ts";
import type { SessionRecord } from "../state/store.ts";
import { finalizeRunRequest } from "./request.ts";
import {
  type CliLaunchDependencies,
  createCliLaunch,
  defaultCliLaunchDependencies,
} from "./session-launch.ts";
import type { CliAgent, EffectiveRunRequest, ResolvedRunRequest } from "./types.ts";

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
  close(): Promise<void>;
  kill(): Promise<void>;
  teardown(): Promise<void>;
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

  constructor(request: EffectiveRunRequest, id: string, launch: () => Promise<ElwoodAgentSession>) {
    super();
    this.request = request;
    this.agent = request.agent;
    this.id = id;
    this.resumed = request.resume !== undefined;
    this.launchSession = launch;
  }

  protected readonly readBoundarySignal = defaultBoundarySignal;

  protected async launch(): Promise<ElwoodAgentSession> {
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

  override async teardown(): Promise<void> {
    const live = await this.settledSession();
    if (live !== undefined) return live.teardown();
    removeSessionIdentity(this.request.stateDir, this.id, this.agent);
  }

  private async performSetup(): Promise<void> {
    await this.start();
    if (this.resumed && this.request.model !== undefined) await this.setModel(this.request.model);
    if (!this.resumed && this.request.persona !== undefined) {
      await this.send(this.request.persona);
    }
  }
}
