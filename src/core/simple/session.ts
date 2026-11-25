/**
 * Adapter-neutral lazy facade for ergonomic turns and the low-level control surface.
 * Implements PRD §5.8.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "../activity/index.ts";
import type { ElwoodAgentSession } from "../agent-session.ts";
import type { ElwoodDialogRequest } from "../dialogs/types.ts";
import { ImageCaptures } from "../images/capture.ts";
import type { SendOptions } from "../images/types.ts";
import type { ElwoodLoopRequest, ElwoodLoopSnapshot } from "../loops/types.ts";
import type { AgentModelOption } from "../models/rows.ts";
import type {
  ElwoodQuestionAnswer,
  ElwoodQuestionAnswerOptions,
  ElwoodQuestionRequest,
} from "../questions/types.ts";
import { emptySessionStats, type SessionStats } from "../stats/snapshot-types.ts";
import type {
  ActivityMatch,
  ElwoodSessionStatus,
  StatusMatch,
  TerminalSize,
  Unsubscribe,
} from "../types.ts";
import { capturedSend, capturedTurn } from "./captured-input.ts";
import { closeSession } from "./close.ts";
import type { TurnEvent } from "./events.ts";
import { SubscriptionRegistry } from "./subscriptions.ts";
import type { NativeTurnReader } from "./turn-identity.ts";
import { TurnQueue } from "./turn-queue.ts";
import type { BoundarySignalReader, TurnOptions } from "./turn-types.ts";

export type { TurnOptions } from "./turn-types.ts";
/** Lazy public session over one Elwood agent; only ergonomic turns serialize. */
export abstract class SessionBase<
  S extends ElwoodAgentSession<Agent>,
  Agent extends ElwoodAgentKind = ElwoodAgentKind,
> {
  private live: S | undefined;
  private starting: Promise<S> | undefined;
  private readonly turns = new TurnQueue();
  private readonly images = new ImageCaptures();
  private readonly subscriptions = new SubscriptionRegistry<S>();

  protected abstract launch(): Promise<S>;
  protected abstract readonly readBoundarySignal: BoundarySignalReader;
  protected readonly readNativeTurn: NativeTurnReader | undefined = undefined;

  /** The started underlying session, or `undefined` before the first start. */
  get session(): S | undefined {
    return this.live;
  }

  get status(): ElwoodSessionStatus {
    return this.live?.status ?? "starting";
  }
  getStats(): Promise<SessionStats> {
    return this.live?.getStats() ?? Promise.resolve(emptySessionStats("starting"));
  }

  /** Start the underlying session eagerly. Idempotent and concurrent-safe (C-API-47). */
  start(): Promise<S> {
    if (this.live) return Promise.resolve(this.live);
    this.starting ??= this.launch().then(
      (session) => {
        // Store the session before attaching subscriptions. Startup replay can call host
        // code synchronously, so even a throwing subscriber must leave the PTY reachable.
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
      this.readNativeTurn,
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

  // Raw turn-producing methods bypass the send/stream queue (§5.8).
  // Call them only when no ergonomic turn is in flight.
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
  /** Start the session if needed, then list any verified workspace trust prompt. */
  async listDialogs(): Promise<readonly ElwoodDialogRequest<Agent>[]> {
    return (await this.start()).listDialogs();
  }

  async listQuestions(): Promise<readonly ElwoodQuestionRequest[]> {
    return (await this.start()).listQuestions();
  }
  async answerQuestions(
    requestId: string,
    answers: readonly ElwoodQuestionAnswer[],
    options?: ElwoodQuestionAnswerOptions,
  ): Promise<void> {
    return (await this.start()).answerQuestions(requestId, answers, options);
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
  protected async closeLiveSession(live: S): Promise<void> {
    await closeSession(live);
  }
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
