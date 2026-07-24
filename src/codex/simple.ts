/**
 * `SimpleCodexSession`: the ergonomic Codex facade (PRD §5.8). Constructed synchronously
 * with the same options as `startCodex` (with `cwd` defaulting to `process.cwd()`), it
 * starts Codex lazily on the first `send`/`stream`/`start` and exposes `send`/`stream`/
 * `close`. A thin wrapper over `startCodex` — no new behavior.
 */

import { SimpleSession } from "../core/simple/session.ts";
import { startCodex } from "./session.ts";
import type { CodexSession, StartCodexOptions } from "./session-types.ts";

/** Options for the ergonomic facade: `startCodex`'s options with an optional `cwd`. */
export type SimpleCodexOptions = Omit<StartCodexOptions, "cwd"> & { readonly cwd?: string };

export class SimpleCodexSession extends SimpleSession<CodexSession> {
  private readonly options: SimpleCodexOptions;

  constructor(options: SimpleCodexOptions = {}) {
    super();
    this.options = options;
  }

  protected launch(): Promise<CodexSession> {
    return startCodex({ ...this.options, cwd: this.options.cwd ?? process.cwd() });
  }
}
