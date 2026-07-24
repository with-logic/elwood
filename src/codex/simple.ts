/**
 * `CodexSession`: the public Codex session (PRD §5.8). Constructed synchronously with the
 * same options as the low-level factory (`cwd` defaults to `process.cwd()`), it starts
 * Codex lazily on first use and exposes both the ergonomic `send`/`stream` API and the
 * full control surface (all lazy-start-aware). Prefer this over the deprecated `startCodex`
 * factory.
 */

import { resolveSessionPaths } from "../core/simple/resolve-paths.ts";
import { SessionBase } from "../core/simple/session.ts";
import type { AssertStopBoundary } from "../core/simple/turn.ts";
import type { Unsubscribe } from "../core/types.ts";
import type { CodexHookEventFor } from "./hooks.ts";
import { startCodex } from "./session.ts";
import type {
  CodexEventHandler,
  CodexEventName,
  CodexSessionApi,
  StartCodexOptions,
} from "./session-types.ts";

// Compile-time TURN-CAPABILITY guard (mirrors Claude): the completeness oracle reads the `Stop`
// hook's `last_assistant_message`, so the REAL Codex `Stop` payload must carry the oracle's
// required fields. A renamed/dropped/retyped field makes `AssertStopBoundary` resolve to `never`,
// failing compilation instead of silently disabling the oracle. (A generic `TurnSession` base
// bound cannot enforce this — method bivariance — so this concrete-payload check is the guard.)
type _StopSatisfiesBoundary = AssertStopBoundary<CodexHookEventFor<"Stop">>;
const _stopBoundaryCheck: _StopSatisfiesBoundary = true;
void _stopBoundaryCheck;

/** Options for `CodexSession`: the low-level `startCodex` options with an optional `cwd`. */
export type CodexSessionOptions = Omit<StartCodexOptions, "cwd"> & { readonly cwd?: string };

export class CodexSession extends SessionBase<CodexSessionApi> {
  private readonly options: StartCodexOptions;

  constructor(options: CodexSessionOptions = {}) {
    super();
    // SNAPSHOT cwd + relative stateDir at CONSTRUCTION (see resolveSessionPaths): a chdir between
    // construction and lazy launch must not change which project is launched or where state lands.
    this.options = resolveSessionPaths(options);
  }

  protected launch(): Promise<CodexSessionApi> {
    return startCodex(this.options);
  }

  /** Typed event subscription over the Codex event map (buffered before start). */
  on<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>): Unsubscribe {
    // Keyed by (event, handler) so the disposer works before AND after start and `off` scopes
    // to the exact event even when a handler is reused; the closure keeps types (no cast).
    return this.subscribe(event, handler, (session) => session.on(event, handler));
  }
  off<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>): void {
    this.unsubscribe(event, handler);
  }
}
