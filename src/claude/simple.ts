/**
 * `ClaudeSession`: the public Claude session (PRD §5.8). Constructed synchronously with
 * the same options as the low-level factory (`cwd` defaults to `process.cwd()`), it starts
 * Claude lazily on first use and exposes both the ergonomic `send`/`stream` API and the
 * full control surface (all lazy-start-aware). Prefer this over the deprecated
 * `startClaude` factory.
 */

import { resolveSessionPaths } from "../core/simple/resolve-paths.ts";
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

// Compile-time TURN-CAPABILITY guard: the completeness oracle reads the `Stop` hook's
// `last_assistant_message`, so the REAL Claude `Stop` payload must carry the oracle's required
// fields. `AssertStopBoundary` resolves to `never` — failing compilation — if that contract
// drifts (renames/drops/retypes the field), catching the exact way an adapter could silently
// lose oracle semantics. (A `SessionBase<S extends TurnSession>` bound cannot enforce this:
// method-parameter bivariance lets a hook-less `on` structurally satisfy the `hook` overload,
// so this concrete-payload assertion — not a generic bound — is the effective guard.)
type _StopSatisfiesBoundary = AssertStopBoundary<ClaudeHookEventFor<"Stop">>;
const _stopBoundaryCheck: _StopSatisfiesBoundary = true;
void _stopBoundaryCheck;

/** Options for `ClaudeSession`: the low-level `startClaude` options with an optional `cwd`. */
export type ClaudeSessionOptions = Omit<StartClaudeOptions, "cwd"> & { readonly cwd?: string };

export class ClaudeSession extends SessionBase<ClaudeSessionApi> {
  private readonly options: StartClaudeOptions;

  constructor(options: ClaudeSessionOptions = {}) {
    super();
    // SNAPSHOT the working directory (and resolve any relative stateDir against it) at
    // CONSTRUCTION, not at lazy launch: a `process.chdir()` between `new ClaudeSession()` and the
    // first use must not change which project is launched/auto-trusted or where state is written.
    this.options = resolveSessionPaths(options);
  }

  protected launch(): Promise<ClaudeSessionApi> {
    return startClaude(this.options);
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
