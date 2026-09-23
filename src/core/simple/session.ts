/**
 * Adapter-neutral lazy facade for ergonomic turns and the low-level control surface.
 * Implements PRD §5.8.
 */

import type { ElwoodActivityEvent } from "../activity/index.ts";
import type { ElwoodAgentSession } from "../agent-session.ts";
import { elwoodError, toError } from "../errors.ts";
import { ImageCaptures } from "../images/capture.ts";
import type { SendOptions } from "../images/types.ts";
import type { ElwoodLoopRequest, ElwoodLoopSnapshot } from "../loops/types.ts";
import type { AgentModelOption } from "../models/rows.ts";
import type {
  ActivityMatch,
  ElwoodSessionStatus,
  StatusMatch,
  TerminalSize,
  Unsubscribe,
} from "../types.ts";
import { capturedSend, capturedTurn } from "./captured-input.ts";
import type { TurnEvent } from "./events.ts";
import { SubscriptionRegistry } from "./subscriptions.ts";
import { TurnQueue } from "./turn-queue.ts";
import type { BoundarySignalReader, TurnOptions } from "./turn-types.ts";

export type { TurnOptions } from "./turn-types.ts";
/** Lazy public session over one Elwood agent; only ergonomic turns serialize. */
export abstract class SessionBase<S extends ElwoodAgentSession> {
  private live: S | undefined;
  private starting: Promise<S> | undefined;
  private readonly turns = new TurnQueue();
  private readonly images = new ImageCaptures();
  private readonly subscriptions = new SubscriptionRegistry<S>();

  /**
   * Boots the underlying session. Single-flight: the base memoizes an in-flight start so
   * concurrent callers share it — but a launch that REJECTS is retryable, so `launch` may be
   * called again after a prior failure (never while one is still in flight or after success).
   */
  protected abstract launch(): Promise<S>;

  /** Adapter-owned hook completeness signal; never displayed (C-CLAUDE-15). */
  protected abstract readonly readBoundarySignal: BoundarySignalReader;

  /** Adapter-native comparison identity; raw submission remains unchanged. */
  protected submittedPrompt = (prompt: string): string => prompt;

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
        this.images.shareWith(session); // before `session` is reachable: ONE clone ceiling (C-API-44)
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
    return capturedTurn(
      this.images,
      this.turns,
      this,
      this.readBoundarySignal,
      prompt,
      options,
      this.submittedPrompt(prompt),
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
  sendPrompt(prompt: string, options?: SendOptions): Promise<void> {
    return capturedSend(this.images, this, "sendPrompt", prompt, options);
  }
  sendMessage(message: string, options?: SendOptions): Promise<void> {
    return capturedSend(this.images, this, "sendMessage", message, options);
  }
  sendGuidance(message: string, options?: SendOptions): Promise<void> {
    return capturedSend(this.images, this, "sendGuidance", message, options);
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
  async createLoop(request: ElwoodLoopRequest): Promise<ElwoodLoopSnapshot> {
    return (await this.start()).createLoop(request);
  }
  async listLoops(): Promise<readonly ElwoodLoopSnapshot[]> {
    return (await this.start()).listLoops();
  }
  async cancelLoop(loopId: string): Promise<void> {
    return (await this.start()).cancelLoop(loopId);
  }

  /** Stop the underlying session, joining an in-flight lazy start (C-API-51). */
  async close(): Promise<void> {
    const live = await this.settledSession();
    if (!live) return;
    await this.closeLiveSession(live);
  }
  /** Stop one known-live session, preserving the public close fallback and diagnostics. */
  protected async closeLiveSession(live: S): Promise<void> {
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
  protected async settledSession(): Promise<S | undefined> {
    return this.live ?? (this.starting ? await this.starting.catch(() => undefined) : undefined);
  }
}
