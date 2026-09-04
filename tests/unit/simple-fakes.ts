/**
 * Shared fakes for the ergonomic-session unit tests (PRD §5.8): a controllable underlying
 * session that scripts a turn per `sendMessage` and records every delegated control call,
 * plus a `TestSimple` facade over `SessionBase` exposing a typed `on`/`off`.
 */

import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import type {
  ElwoodAgentSession,
  ElwoodCommonEventMap,
  ElwoodCommonEventName,
} from "../../src/core/agent-session.ts";
import type { SendOptions } from "../../src/core/images/types.ts";
import type { ElwoodLoopRequest, ElwoodLoopSnapshot } from "../../src/core/loops/types.ts";
import type { AgentModelOption } from "../../src/core/model-rows.ts";
import { SessionBase } from "../../src/core/simple/session.ts";
import { defaultBoundarySignal } from "../../src/core/simple/turn.ts";
import type {
  ActivityMatch,
  ElwoodSessionStatus,
  StatusMatch,
  TerminalSize,
  Unsubscribe,
} from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import type { ElwoodTerminal } from "../../src/terminal/headless.ts";

export type Emitter = TypedEmitter<ElwoodCommonEventMap>;

export function activity(partial: Partial<ElwoodActivityEvent>): ElwoodActivityEvent {
  return {
    elwoodSessionId: "s1",
    agent: "claude",
    source: "transcript",
    kind: "assistant_message",
    label: "assistant",
    ...partial,
  };
}

/**
 * A controllable underlying session that scripts a turn per `sendMessage` and records
 * delegations. It genuinely `implements ElwoodAgentSession` (no `as unknown as` at the launch
 * boundary), so a signature change in the real interface fails these tests to COMPILE.
 */
export class FakeUnderlying implements ElwoodAgentSession {
  readonly emitter: Emitter = new TypedEmitter<ElwoodCommonEventMap>();
  readonly elwoodSessionId = "s1";
  readonly cwd = "/fake";
  readonly terminal = { snapshot: () => "", write: () => {} } as unknown as ElwoodTerminal;
  status: ElwoodSessionStatus = "ready";
  stops = 0;
  kills = 0;
  sends = 0; // sendMessage invocations, so a test can prove NO submission happened before start
  readonly calls: string[] = [];
  // The exact arguments each delegated method received, so tests can prove faithful forwarding.
  readonly args: Record<string, unknown[]> = {};
  readonly loopSnapshot: ElwoodLoopSnapshot = {
    id: "loop-1",
    message: "check progress",
    mode: "idle",
    jitterMs: 1,
    createdAt: 1,
    expiresAt: 2,
    state: "waiting",
  };
  private turn = 0;
  script: (emitter: Emitter, turnId: string) => void = defaultScript;
  statusDecisions() {
    return [];
  }
  on<E extends ElwoodCommonEventName>(
    event: E,
    handler: (e: ElwoodCommonEventMap[E]) => void,
  ): Unsubscribe {
    return this.emitter.on(event, handler);
  }
  off<E extends ElwoodCommonEventName>(
    event: E,
    handler: (e: ElwoodCommonEventMap[E]) => void,
  ): void {
    this.emitter.off(event, handler);
  }
  sendMessage(message: string, options?: SendOptions): Promise<void> {
    this.sends += 1;
    this.args["sendMessage"] = options === undefined ? [message] : [message, options];
    this.turn += 1;
    this.script(this.emitter, `t${this.turn}`);
    return Promise.resolve();
  }
  sendPrompt(prompt: string, options?: SendOptions): Promise<void> {
    return this.record("sendPrompt", options === undefined ? [prompt] : [prompt, options]);
  }
  sendGuidance(message: string, options?: SendOptions): Promise<void> {
    return this.record("sendGuidance", options === undefined ? [message] : [message, options]);
  }
  sendKeys(input: string | Uint8Array): Promise<void> {
    return this.record("sendKeys", [input]);
  }
  resize(size: TerminalSize): Promise<void> {
    return this.record("resize", [size]);
  }
  interrupt(options?: { readonly timeoutMs?: number }): Promise<void> {
    return this.record("interrupt", [options]);
  }
  compact(options?: { readonly timeoutMs?: number }): Promise<void> {
    return this.record("compact", [options]);
  }
  setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void> {
    return this.record("setModel", [id, options]);
  }
  teardown(): Promise<void> {
    return this.record("teardown", []);
  }
  listModels(options?: { readonly timeoutMs?: number }): Promise<readonly AgentModelOption[]> {
    void this.record("listModels", [options]);
    return Promise.resolve([]);
  }
  waitForStatus(match: StatusMatch, timeoutMs?: number): Promise<ElwoodSessionStatus> {
    void this.record("waitForStatus", timeoutMs === undefined ? [match] : [match, timeoutMs]);
    return Promise.resolve("ready");
  }
  waitForActivity(match: ActivityMatch, timeoutMs?: number): Promise<ElwoodActivityEvent> {
    void this.record("waitForActivity", timeoutMs === undefined ? [match] : [match, timeoutMs]);
    return Promise.resolve(activity({ text: "x" }));
  }
  createLoop(request: ElwoodLoopRequest): Promise<ElwoodLoopSnapshot> {
    void this.record("createLoop", [request]);
    return Promise.resolve(this.loopSnapshot);
  }
  listLoops(): Promise<readonly ElwoodLoopSnapshot[]> {
    void this.record("listLoops", []);
    return Promise.resolve([this.loopSnapshot]);
  }
  cancelLoop(loopId: string): Promise<void> {
    return this.record("cancelLoop", [loopId]);
  }
  stop(): Promise<void> {
    this.stops += 1;
    return Promise.resolve();
  }
  kill(): Promise<void> {
    this.kills += 1;
    return Promise.resolve();
  }
  private record(name: string, a: unknown[]): Promise<void> {
    this.calls.push(name);
    this.args[name] = a;
    return Promise.resolve();
  }
}

export function defaultScript(emitter: Emitter, turnId: string): void {
  emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
  emitter.emit("activity", activity({ text: turnId, turnId }));
  emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
}

/** A test facade over SessionBase that records launches and exposes a typed on/off. */
export class TestSimple extends SessionBase<ElwoodAgentSession> {
  launches = 0;
  readonly underlying = new FakeUnderlying();
  protected launch(): Promise<ElwoodAgentSession> {
    this.launches += 1;
    return Promise.resolve(this.underlying); // no cast — FakeUnderlying implements the interface
  }
  protected readBoundarySignal = defaultBoundarySignal;
  on<E extends keyof ElwoodCommonEventMap>(
    event: E,
    handler: (e: ElwoodCommonEventMap[E]) => void,
  ) {
    return this.subscribe(event, handler, (session) => session.on(event, handler));
  }
  off<E extends keyof ElwoodCommonEventMap>(
    event: E,
    handler: (e: ElwoodCommonEventMap[E]) => void,
  ) {
    this.unsubscribe(event, handler);
  }
}
