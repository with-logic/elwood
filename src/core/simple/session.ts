/**
 * The adapter-neutral ergonomic session facade (PRD §5.8): lazy start, serialized turns,
 * and the `send`/`stream`/`close` convenience over any Elwood session. A thin wrapper —
 * it adds no lifecycle or persistence behavior and reads only public events, delegating
 * to a `start()` the concrete subclass supplies (SimpleClaudeSession/SimpleCodexSession).
 */

import type { ElwoodAgentSession } from "../agent-session.ts";
import type { SimpleTurnEvent } from "./events.ts";
import { streamTurn } from "./turn.ts";

/** Per-call turn options (currently just the settle deadline). */
export type SimpleTurnOptions = {
  /** Max wall-clock for the whole turn before rejecting with `wait_timeout` (default 300s). */
  readonly timeoutMs?: number;
  /**
   * Quiet window after the `ready` settle for trailing transcript-sourced content to
   * flush before the turn ends (default 750ms). Assistant text can arrive just after
   * `ready`; a content event within this window defers the end. Set 0 to end at `ready`.
   */
  readonly settleGraceMs?: number;
};

/**
 * Ergonomic facade over one Elwood session. Constructed synchronously; the underlying
 * session starts lazily on the first `send`/`stream` (or explicit `start()`). Turns are
 * serialized so one turn's activity never interleaves with another's.
 */
export abstract class SimpleSession<S extends ElwoodAgentSession> {
  private started: S | undefined;
  private starting: Promise<S> | undefined;
  // The tail of the serialized-turn chain: each turn awaits the previous one settling.
  private tail: Promise<unknown> = Promise.resolve();

  /** Boots the underlying session. Called at most once; the base memoizes the result. */
  protected abstract launch(): Promise<S>;

  /** The started underlying session, or `undefined` before the first start (C-API-47). */
  get session(): S | undefined {
    return this.started;
  }

  /** Start the underlying session eagerly. Idempotent and concurrent-safe (C-API-47). */
  start(): Promise<S> {
    if (this.started) return Promise.resolve(this.started);
    this.starting ??= this.launch().then((session) => {
      this.started = session;
      this.starting = undefined;
      return session;
    });
    return this.starting;
  }

  /** Stream one turn's simplified content events; ends when the turn settles (C-API-48). */
  stream(prompt: string, options?: SimpleTurnOptions): AsyncGenerator<SimpleTurnEvent> {
    return this.serialize((session) =>
      streamTurn(session, prompt, options?.timeoutMs, options?.settleGraceMs),
    );
  }

  /** Send one turn and resolve with its assistant text, `\n\n`-joined (C-API-49). */
  async send(prompt: string, options?: SimpleTurnOptions): Promise<string> {
    const chunks: string[] = [];
    for await (const event of this.stream(prompt, options)) {
      if (event.type === "text") chunks.push(event.text);
    }
    return chunks.join("\n\n");
  }

  /** Stop the underlying session; a no-op if it never started (C-API-51). */
  async close(): Promise<void> {
    const session = this.started;
    if (!session) return;
    try {
      await session.stop();
    } catch {
      await session.kill();
    }
  }

  /**
   * Serialize a turn onto the tail: start the session (lazy), then run `body` only after
   * every prior turn has fully settled, so turns never overlap (C-API-50). Returned as an
   * async generator so `stream` stays lazy — nothing runs until the caller iterates.
   */
  private async *serialize(
    body: (session: S) => AsyncGenerator<SimpleTurnEvent>,
  ): AsyncGenerator<SimpleTurnEvent> {
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
