/**
 * The adapter-neutral session base (PRD §5.8): a single public session object with both
 * the ergonomic `send`/`stream` API and the full low-level control surface, all
 * lazy-start-aware. Constructed synchronously; the underlying PTY-backed session starts
 * lazily on the first use (or an explicit `start()`). A thin wrapper — it adds no
 * lifecycle or persistence behavior and delegates every method to the live session.
 */

import type { ElwoodActivityEvent } from "../activity.ts";
import type { ElwoodAgentSession } from "../agent-session.ts";
import type { SendOptions } from "../images/types.ts";
import type { AgentModelOption } from "../model-rows.ts";
import type {
  ActivityMatch,
  ElwoodSessionStatus,
  StatusMatch,
  TerminalSize,
  Unsubscribe,
} from "../types.ts";
import type { TurnEvent } from "./events.ts";
import { streamTurn } from "./turn.ts";

/** Per-call turn options. */
export type TurnOptions = {
  /**
   * Optional whole-turn ceiling before rejecting with `wait_timeout`. Default NONE — a
   * turn may legitimately run for hours (running a test suite, polling a PR), so a live
   * turn is never failed by a clock; a dead session ends it via terminal status.
   */
  readonly timeoutMs?: number;
  /**
   * Cap on the transcript catch-up AFTER the agent reaches `ready` (default 10s). The
   * flush should be near-instant; a longer stall means something broke, so the turn
   * rejects with `wait_timeout` rather than leaving the caller hanging.
   */
  readonly catchUpMs?: number;
};

/** A buffered `on`/`off` subscription, (re)applied to the live session once started. */
type PendingSub = { readonly event: string; readonly handler: (event: never) => unknown };

/**
 * One public session over an Elwood agent. Constructed synchronously; the underlying
 * session starts lazily on the first `send`/`stream`/control call (or explicit `start()`).
 * `send`/`stream` turns are serialized so one turn's activity never interleaves with
 * another's; control methods (`interrupt`, `sendKeys`, `stop`, `kill`, …) go through
 * immediately. `on`/`off` may be called before start — subscriptions are buffered and
 * attached when the session starts, so subscribing never forces a start.
 */
export abstract class SessionBase<S extends ElwoodAgentSession> {
  private live: S | undefined;
  private starting: Promise<S> | undefined;
  // The tail of the serialized-turn chain: each turn awaits the previous one settling.
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pendingSubs: PendingSub[] = [];

  /** Boots the underlying session. Called at most once; the base memoizes the result. */
  protected abstract launch(): Promise<S>;

  /** The started underlying session, or `undefined` before the first start. */
  get session(): S | undefined {
    return this.live;
  }

  /** The current status; `starting` until the underlying session exists. */
  get status(): ElwoodSessionStatus {
    return this.live?.status ?? "starting";
  }

  /** Start the underlying session eagerly. Idempotent and concurrent-safe (C-API-47). */
  start(): Promise<S> {
    if (this.live) return Promise.resolve(this.live);
    this.starting ??= this.launch().then((session) => {
      for (const sub of this.pendingSubs) session.on(sub.event as never, sub.handler as never);
      this.live = session;
      this.starting = undefined;
      return session;
    });
    return this.starting;
  }

  /** Stream one turn's simplified content events; ends when the turn settles (C-API-48). */
  stream(prompt: string, options?: TurnOptions): AsyncGenerator<TurnEvent> {
    return this.serialize((session) => streamTurn(session, prompt, options ?? {}));
  }

  /** Send one turn and resolve with its assistant text, `\n\n`-joined (C-API-49). */
  async send(prompt: string, options?: TurnOptions): Promise<string> {
    const chunks: string[] = [];
    for await (const event of this.stream(prompt, options)) {
      if (event.type === "text") chunks.push(event.text);
    }
    return chunks.join("\n\n");
  }

  /**
   * Subscribe to a live session event. Buffered before start and attached on start, so
   * subscribing never forces a start; returns an `Unsubscribe` that works either way. The
   * public, adapter-typed `on`/`off` in each subclass delegate here.
   */
  protected subscribe(event: string, handler: (event: never) => unknown): Unsubscribe {
    if (this.live) return this.live.on(event as never, handler as never);
    this.pendingSubs.push({ event, handler });
    return () => this.unsubscribe(event, handler);
  }

  /** Unsubscribe a handler, whether buffered (pre-start) or live. */
  protected unsubscribe(event: string, handler: (event: never) => unknown): void {
    const index = this.pendingSubs.findIndex((s) => s.event === event && s.handler === handler);
    if (index >= 0) this.pendingSubs.splice(index, 1);
    this.live?.off(event as never, handler as never);
  }

  // Control surface: each awaits lazy start, then delegates. Only `send`/`stream` serialize;
  // these go straight through (an `interrupt` must reach a running turn, not queue behind it).
  async sendPrompt(prompt: string, options?: SendOptions): Promise<void> {
    return (await this.start()).sendPrompt(prompt, options);
  }
  async sendMessage(message: string, options?: SendOptions): Promise<void> {
    return (await this.start()).sendMessage(message, options);
  }
  async sendGuidance(message: string, options?: SendOptions): Promise<void> {
    return (await this.start()).sendGuidance(message, options);
  }
  async sendKeys(input: string | Uint8Array): Promise<void> {
    return (await this.start()).sendKeys(input);
  }
  async resize(size: TerminalSize): Promise<void> {
    return (await this.start()).resize(size);
  }
  async interrupt(options?: { readonly timeoutMs?: number }): Promise<void> {
    return (await this.start()).interrupt(options);
  }
  async compact(options?: { readonly timeoutMs?: number }): Promise<void> {
    return (await this.start()).compact(options);
  }
  async listModels(options?: {
    readonly timeoutMs?: number;
  }): Promise<readonly AgentModelOption[]> {
    return (await this.start()).listModels(options);
  }
  async setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void> {
    return (await this.start()).setModel(id, options);
  }
  async waitForStatus(match: StatusMatch, timeoutMs?: number): Promise<ElwoodSessionStatus> {
    return (await this.start()).waitForStatus(match, timeoutMs);
  }
  async waitForActivity(match: ActivityMatch, timeoutMs?: number): Promise<ElwoodActivityEvent> {
    return (await this.start()).waitForActivity(match, timeoutMs);
  }

  /** Stop the underlying session (falling back to `kill`); a no-op if it never started. */
  async close(): Promise<void> {
    if (!this.live) return;
    try {
      await this.live.stop();
    } catch {
      await this.live.kill();
    }
  }

  /** Stop the underlying session; a no-op if it never started. */
  async stop(): Promise<void> {
    await this.live?.stop();
  }
  /** Kill the underlying session; a no-op if it never started. */
  async kill(): Promise<void> {
    await this.live?.kill();
  }
  /** Tear down the underlying session; a no-op if it never started. */
  async teardown(): Promise<void> {
    await this.live?.teardown();
  }

  /**
   * Serialize a turn onto the tail: start the session (lazy), then run `body` only after
   * every prior turn has fully settled, so turns never overlap (C-API-50). Returned as an
   * async generator so `stream` stays lazy — nothing runs until the caller iterates.
   */
  private async *serialize(
    body: (session: S) => AsyncGenerator<TurnEvent>,
  ): AsyncGenerator<TurnEvent> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prior; // wait for the previous turn to fully settle before starting this one
      const session = await this.start();
      yield* body(session);
    } finally {
      release();
    }
  }
}
