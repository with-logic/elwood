/**
 * `ClaudeSession`: the public Claude session (PRD §5.8). Constructed synchronously with
 * the same options as the low-level factory (`cwd` defaults to `process.cwd()`), it starts
 * Claude lazily on first use and exposes both the ergonomic `send`/`stream` API and the
 * full control surface (all lazy-start-aware). Prefer this over the deprecated
 * `startClaude` factory.
 */

import { SessionBase } from "../core/simple/session.ts";
import type { AssertStopBoundary, TurnSession } from "../core/simple/turn.ts";
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

// Compile-time conformance: the live Claude API must be TURN-CAPABLE — i.e. carry the `hook`
// event the completeness oracle subscribes to. `SessionBase`'s structural bound alone would
// let a session without `hook` pass; this asserts the CONCRETE API type has it.
type _ApiIsTurnCapable = ClaudeSessionApi extends TurnSession ? true : never;
const _turnCapableCheck: _ApiIsTurnCapable = true;
void _turnCapableCheck;

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
    // base's buffer boundary, so the event↔payload correlation is preserved. The base keys the
    // registration by (event, handler), so the returned disposer works before AND after start.
    return this.subscribe(event, handler, (session) => session.on(event, handler));
  }
  off<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): void {
    // Remove the registration matching this exact (event, handler) — detaching a live sub if
    // attached — so a handler reused across events is unsubscribed from the right one only.
    this.unsubscribe(event, handler);
  }

  /** Drive the interactive `/login` re-authentication flow (Claude-only, C-API-43). */
  async login(options: ClaudeLoginOptions): Promise<void> {
    return (await this.start()).login(options);
  }
}
