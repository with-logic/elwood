/**
 * Typed fake sessions, signals, clocks, and streams for headless CLI lifecycle tests.
 */

import type { CliLifecycleClock, CliSignalSource } from "../../src/cli/lifecycle.ts";
import type { CliSessionFacade } from "../../src/cli/session.ts";
import type { CliWritable } from "../../src/cli/stream.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import type { ElwoodCommonEventMap } from "../../src/core/agent-session.ts";
import type { TurnEvent } from "../../src/core/simple/events.ts";
import type { TurnOptions } from "../../src/core/simple/turn-types.ts";
import type { ElwoodSessionStatus, TerminalSize, Unsubscribe } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { FakeUnderlying } from "../unit/simple-fakes.ts";

export class FakeCliSession implements CliSessionFacade {
  readonly agent = "codex" as const;
  readonly id = "s1";
  readonly resumed = false;
  readonly underlying = new FakeUnderlying();
  readonly emitter = new TypedEmitter<ElwoodCommonEventMap>();
  started = false;
  closes = 0;
  teardowns = 0;
  interrupts = 0;
  kills = 0;
  readonly resizes: TerminalSize[] = [];
  cleanupError: Error | undefined;
  events: readonly TurnEvent[] = [{ type: "text", text: "ok" }];
  setupWork: (session: FakeCliSession) => Promise<void> = async (session) => {
    await session.start();
  };
  streamWork: (session: FakeCliSession) => Promise<void> = async () => {};
  cleanupWork: (session: FakeCliSession) => void = () => {};
  turnOptions: TurnOptions | undefined;
  resumable = true;

  get status(): ElwoodSessionStatus {
    return this.started ? this.underlying.status : "starting";
  }
  get session() {
    return this.started ? this.underlying : undefined;
  }
  start() {
    this.started = true;
    return Promise.resolve(this.underlying);
  }
  setup(): Promise<void> {
    return this.setupWork(this);
  }
  async *stream(_prompt: string, options?: TurnOptions): AsyncGenerator<TurnEvent> {
    this.turnOptions = options;
    for (const event of this.events) yield event;
    await this.streamWork(this);
  }
  async send(prompt: string, options?: TurnOptions): Promise<string> {
    const text: string[] = [];
    for await (const event of this.stream(prompt, options))
      if (event.type === "text") text.push(event.text);
    return text.join("\n\n");
  }
  on<E extends keyof ElwoodCommonEventMap>(
    event: E,
    handler: (value: ElwoodCommonEventMap[E]) => void,
  ): Unsubscribe {
    return this.emitter.on(event, handler);
  }
  interrupt(): Promise<void> {
    this.interrupts += 1;
    return Promise.resolve();
  }
  resize(size: TerminalSize): Promise<void> {
    this.resizes.push(size);
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closes += 1;
    this.cleanupWork(this);
    return this.cleanupError === undefined ? Promise.resolve() : Promise.reject(this.cleanupError);
  }
  kill(): Promise<void> {
    this.kills += 1;
    return Promise.resolve();
  }
  teardown(): Promise<void> {
    this.teardowns += 1;
    this.cleanupWork(this);
    return this.cleanupError === undefined ? Promise.resolve() : Promise.reject(this.cleanupError);
  }
  preservedSessionId(): string | null {
    return this.resumable ? this.id : null;
  }
  emitActivity(partial: Partial<ElwoodActivityEvent>): void {
    this.emitter.emit("activity", {
      elwoodSessionId: this.id,
      agent: this.agent,
      source: "terminal",
      kind: "attention",
      label: "dialog",
      ...partial,
    });
  }
}

export class FakeSignals implements CliSignalSource {
  handler: (() => void) | undefined;
  unbound = false;
  onSigint(handler: () => void): Unsubscribe {
    this.handler = handler;
    return () => {
      this.unbound = true;
      this.handler = undefined;
    };
  }
  emit(): void {
    this.handler?.();
  }
}

export class FakeClock implements CliLifecycleClock {
  value = 0;
  readonly delays: number[] = [];
  handler: (() => void) | undefined;
  clears = 0;
  now = (): number => this.value;
  setTimer = (handler: () => void, delayMs: number): unknown => {
    this.handler = handler;
    this.delays.push(delayMs);
    return handler;
  };
  clearTimer = (): void => {
    this.clears += 1;
    this.handler = undefined;
  };
  fire(): void {
    this.handler?.();
  }
}

export class MemoryWriter implements CliWritable {
  value = "";
  writes = 0;
  failAt: number | undefined;
  write(value: string, callback: (error?: Error | null) => void): boolean {
    this.writes += 1;
    if (this.writes === this.failAt) {
      callback(Object.assign(new Error("closed"), { code: "EPIPE" }));
    } else {
      this.value += value;
      callback();
    }
    return true;
  }
  once(_event: "drain", _handler: () => void): void {}
}
