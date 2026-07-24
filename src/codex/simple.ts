/**
 * `CodexSession`: the public Codex session (PRD §5.8). Constructed synchronously with the
 * same options as the low-level factory (`cwd` defaults to `process.cwd()`), it starts
 * Codex lazily on first use and exposes both the ergonomic `send`/`stream` API and the
 * full control surface (all lazy-start-aware). Prefer this over the deprecated `startCodex`
 * factory.
 */

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

// Compile-time conformance: the REAL Codex `Stop` hook payload must carry the oracle's
// REQUIRED boundary fields (mirrors Claude). A renamed/dropped `last_assistant_message` makes
// `AssertStopBoundary` resolve to `never`, failing compilation instead of silently disabling
// the completeness oracle.
type _StopSatisfiesBoundary = AssertStopBoundary<CodexHookEventFor<"Stop">>;
const _stopBoundaryCheck: _StopSatisfiesBoundary = true;
void _stopBoundaryCheck;

/** Options for `CodexSession`: the low-level `startCodex` options with an optional `cwd`. */
export type CodexSessionOptions = Omit<StartCodexOptions, "cwd"> & { readonly cwd?: string };

export class CodexSession extends SessionBase<CodexSessionApi> {
  private readonly options: CodexSessionOptions;

  constructor(options: CodexSessionOptions = {}) {
    super();
    this.options = options;
  }

  protected launch(): Promise<CodexSessionApi> {
    return startCodex({ ...this.options, cwd: this.options.cwd ?? process.cwd() });
  }

  /** Typed event subscription over the Codex event map (buffered before start). */
  on<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>): Unsubscribe {
    return this.subscribe(handler, (session) => session.on(event, handler));
  }
  off<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>): void {
    this.unsubscribe(handler); // remove a still-buffered subscription
    this.session?.off(event, handler); // detach a live one (typed — no cast)
  }
}
