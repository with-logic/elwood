/**
 * The adapter-neutral session base (PRD §5.8): a single public session object with both
 * the ergonomic `send`/`stream` API and the full low-level control surface, all
 * lazy-start-aware. Constructed synchronously; the underlying PTY-backed session starts
 * lazily on the first use (or an explicit `start()`). A thin wrapper — it adds no
 * lifecycle or persistence behavior and delegates every method to the live session.
 */

import type { ElwoodActivityEvent } from "../activity.ts";
import type { ElwoodAgentSession } from "../agent-session.ts";
import { elwoodError, toError } from "../errors.ts";
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
import { SubscriptionRegistry } from "./subscriptions.ts";
import { runTurn } from "./turn.ts";
import { TurnQueue } from "./turn-queue.ts";
import type { BoundarySignalReader, TurnOptions } from "./turn-types.ts";

export type { TurnOptions } from "./turn-types.ts";

/**
 * One public session over an Elwood agent. Constructed synchronously; the underlying session
 * starts lazily on the first `send`/`stream`/operational call (or explicit `start()`).
 * `send`/`stream` turns are serialized so one turn's activity never interleaves with another's;
 * control methods (`interrupt`, `sendKeys`, `stop`, `kill`, …) go through immediately. `on`/`off`
 * may be called before start — buffered and attached on start, so subscribing never forces one.
 * Turn-capability is enforced by the abstract `readBoundarySignal` + each adapter's
 * `AssertStopBoundary`, not a generic type bound (method bivariance defeats that).
 */
export abstract class SessionBase<S extends ElwoodAgentSession> {
  private live: S | undefined;
  private starting: Promise<S> | undefined;
  private readonly turns = new TurnQueue();
  private readonly subscriptions = new SubscriptionRegistry<S>();

  /**
   * Boots the underlying session. Single-flight: the base memoizes an in-flight start so
   * concurrent callers share it — but a launch that REJECTS is retryable, so `launch` may be
   * called again after a prior failure (never while one is still in flight or after success).
   */
  protected abstract launch(): Promise<S>;

  /**
   * Normalizes this adapter's raw `hook` event into the turn completeness signal (the expected
   * final assistant text, or `undefined` when it is not a turn boundary). Abstract so a new adapter
   * MUST supply one — keeping the runner decoupled from adapter hook fields. Adapters assign
   * `defaultBoundarySignal` unless they differ. (Signal-only; never displayed — C-CLAUDE-15.)
   */
  protected abstract readonly readBoundarySignal: BoundarySignalReader;

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
    this.starting ??= this.launch().then(
      (session) => {
        // COMMIT the launched session BEFORE attaching buffered subscriptions: `attach` runs
        // consumer code (and `terminal:data` synchronously replays startup output), which may
        // throw. If it did so before `live` were set, the start would reject with a live PTY
        // that `close()` could never see — an orphaned CLI process. `attachAll` contains each
        // attach so a throwing consumer handler cannot abort the start or orphan the session.
        this.live = session;
        this.starting = undefined;
        this.subscriptions.attachAll(session);
        return session;
      },
      (error) => {
        this.starting = undefined; // a failed start is RETRYABLE — clear so a later call re-launches
        throw error;
      },
    );
    return this.starting;
  }

  /** Stream one turn's simplified content events; ends when the turn settles (C-API-48). */
  stream(prompt: string, options?: TurnOptions): AsyncGenerator<TurnEvent> {
    // Trigger the lazy start SYNCHRONOUSLY (memoized) so a `close()` racing this call joins the
    // same start and can't miss a session a deferred microtask would launch after close (C-API-51).
    // The slot is reserved synchronously too (call order, not iteration order — C-API-50).
    const starting = this.start();
    // Pass THIS adapter's normalizer so the runner reads only the signal, not raw hook fields.
    const readBoundarySignal = this.readBoundarySignal;
    return this.turns.enqueue(() =>
      starting.then((s) => runTurn(s, prompt, { ...(options ?? {}), readBoundarySignal })),
    );
  }

  /** Send one turn and resolve with its assistant text, `\n\n`-joined (C-API-49). */
  async send(prompt: string, options?: TurnOptions): Promise<string> {
    const chunks: string[] = [];
    for await (const event of this.stream(prompt, options)) {
      if (event.type === "text") chunks.push(event.text);
    }
    return chunks.join("\n\n");
  }

  /** Subscribe via a typed `attach` closure (no cast). See {@link SubscriptionRegistry.add}. */
  protected subscribe(
    event: unknown,
    handler: unknown,
    attach: (session: S) => Unsubscribe,
  ): Unsubscribe {
    return this.subscriptions.add(event, handler, attach);
  }

  /** Remove the registration matching BOTH event and handler (so a reused handler is scoped right). */
  protected unsubscribe(event: unknown, handler: unknown): void {
    this.subscriptions.removeByKey(event, handler);
  }

  // Control surface: each awaits lazy start, then delegates; only `send`/`stream` serialize. NOTE:
  // the turn-PRODUCING raw methods (`sendMessage`/`sendPrompt`/`sendGuidance`) are NOT in the
  // ergonomic queue — don't call them concurrently with an in-flight `send`/`stream` (§5.8).
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
  async listModels(o?: { readonly timeoutMs?: number }): Promise<readonly AgentModelOption[]> {
    return (await this.start()).listModels(o);
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

  /**
   * Stop the underlying session (falling back to `kill`); a no-op if it never started. Awaits an
   * IN-FLIGHT lazy start so a racing start can't orphan a live session; a rejected launch = nothing
   * to close (C-API-51).
   */
  async close(): Promise<void> {
    const live =
      this.live ?? (this.starting ? await this.starting.catch(() => undefined) : undefined);
    if (!live) return;
    try {
      await live.stop();
    } catch (stopError) {
      try {
        await live.kill();
      } catch (killError) {
        // Both shutdown paths failed: surface the ORIGINAL stop failure with the kill
        // failure attached, so a repeated cleanup/reap problem stays diagnosable.
        throw elwoodError("termination_failed", "close() failed to stop or kill the session", {
          cause: toError(stopError).message,
          killCause: toError(killError).message,
        });
      }
    }
  }

  // stop/kill/teardown: delegate to the live session; a no-op if it never started (C-API-52).
  async stop(): Promise<void> {
    await this.live?.stop();
  }
  async kill(): Promise<void> {
    await this.live?.kill();
  }
  async teardown(): Promise<void> {
    await this.live?.teardown();
  }
}
