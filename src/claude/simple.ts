/**
 * `ClaudeSession`: the public Claude session (PRD §5.8). Constructed synchronously with
 * the same options as the low-level factory (`cwd` defaults to `process.cwd()`), it starts
 * Claude lazily on first use and exposes both the ergonomic `send`/`stream` API and the
 * full control surface (all lazy-start-aware). Prefer this over the deprecated
 * `startClaude` factory.
 */

import { SessionBase } from "../core/simple/session.ts";
import type { AssertStopBoundary } from "../core/simple/turn.ts";
import type {
  ElwoodEventHandler,
  ElwoodEventName,
  StartClaudeOptions,
  Unsubscribe,
} from "../core/types.ts";
import type { ClaudeHookEventFor } from "./hook-events.ts";
import type { ClaudeLoginOptions } from "./login/types.ts";
import { startClaude } from "./session.ts";
import type { ClaudeSessionApi } from "./session-interface.ts";

// Compile-time conformance: the REAL Claude `Stop` hook payload must carry the oracle's
// REQUIRED boundary fields (`last_assistant_message`, `hook_event_name`). If the adapter
// contract drifts (renames or drops `last_assistant_message`), `AssertStopBoundary` resolves
// to `never` and this fails to compile rather than silently disabling the completeness oracle.
type _StopSatisfiesBoundary = AssertStopBoundary<ClaudeHookEventFor<"Stop">>;
const _stopBoundaryCheck: _StopSatisfiesBoundary = true;
void _stopBoundaryCheck;

/** Options for `ClaudeSession`: the low-level `startClaude` options with an optional `cwd`. */
export type ClaudeSessionOptions = Omit<StartClaudeOptions, "cwd"> & { readonly cwd?: string };

export class ClaudeSession extends SessionBase<ClaudeSessionApi> {
  private readonly options: ClaudeSessionOptions;

  constructor(options: ClaudeSessionOptions = {}) {
    super();
    this.options = options;
  }

  protected launch(): Promise<ClaudeSessionApi> {
    return startClaude({ ...this.options, cwd: this.options.cwd ?? process.cwd() });
  }

  /** Typed event subscription over the Claude event map (buffered before start). */
  on<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): Unsubscribe {
    // The attach closure captures the fully-typed (event, handler) pair — no cast crosses the
    // base's buffer boundary, so the event↔payload correlation is preserved.
    return this.subscribe(handler, (session) => session.on(event, handler));
  }
  off<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): void {
    this.unsubscribe(handler); // remove a still-buffered subscription
    this.session?.off(event, handler); // detach a live one (typed — no cast)
  }

  /** Drive the interactive `/login` re-authentication flow (Claude-only, C-API-43). */
  async login(options: ClaudeLoginOptions): Promise<void> {
    return (await this.start()).login(options);
  }
}
