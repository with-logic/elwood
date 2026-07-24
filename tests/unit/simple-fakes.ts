/**
 * Shared fakes for the ergonomic-session unit tests (PRD §5.8): a controllable underlying
 * session that scripts a turn per `sendMessage` and records every delegated control call,
 * plus a `TestSimple` facade over `SessionBase` exposing a typed `on`/`off`.
 */

import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import type { ElwoodAgentSession, ElwoodCommonEventMap } from "../../src/core/agent-session.ts";
import { SessionBase } from "../../src/core/simple/session.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

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

/** A controllable underlying session: scripts a turn per sendMessage, records delegations. */
export class FakeUnderlying {
  readonly emitter: Emitter = new TypedEmitter<ElwoodCommonEventMap>();
  status = "ready" as const;
  stops = 0;
  kills = 0;
  readonly calls: string[] = [];
  private turn = 0;
  script: (emitter: Emitter, turnId: string) => void = defaultScript;
  on(event: keyof ElwoodCommonEventMap, handler: (e: never) => void) {
    return this.emitter.on(event, handler as never);
  }
  off(event: keyof ElwoodCommonEventMap, handler: (e: never) => void) {
    this.emitter.off(event, handler as never);
  }
  sendMessage(message: string): Promise<void> {
    void message;
    this.turn += 1;
    this.script(this.emitter, `t${this.turn}`);
    return Promise.resolve();
  }
  sendPrompt = () => this.record("sendPrompt");
  sendGuidance = () => this.record("sendGuidance");
  sendKeys = () => this.record("sendKeys");
  resize = () => this.record("resize");
  interrupt = () => this.record("interrupt");
  compact = () => this.record("compact");
  setModel = () => this.record("setModel");
  teardown = () => this.record("teardown");
  listModels(): Promise<readonly never[]> {
    this.calls.push("listModels");
    return Promise.resolve([]);
  }
  waitForStatus(): Promise<string> {
    this.calls.push("waitForStatus");
    return Promise.resolve("ready");
  }
  waitForActivity(): Promise<unknown> {
    this.calls.push("waitForActivity");
    return Promise.resolve(activity({ text: "x" }));
  }
  stop(): Promise<void> {
    this.stops += 1;
    return Promise.resolve();
  }
  kill(): Promise<void> {
    this.kills += 1;
    return Promise.resolve();
  }
  private record(name: string): Promise<void> {
    this.calls.push(name);
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
    return Promise.resolve(this.underlying as unknown as ElwoodAgentSession);
  }
  on<E extends keyof ElwoodCommonEventMap>(
    event: E,
    handler: (e: ElwoodCommonEventMap[E]) => void,
  ) {
    return this.subscribe(event, handler as (e: never) => unknown);
  }
  off<E extends keyof ElwoodCommonEventMap>(
    event: E,
    handler: (e: ElwoodCommonEventMap[E]) => void,
  ) {
    this.unsubscribe(event, handler as (e: never) => unknown);
  }
}
