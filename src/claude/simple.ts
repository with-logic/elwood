/**
 * `SimpleClaudeSession`: the ergonomic Claude facade (PRD §5.8). Constructed
 * synchronously with the same options as `startClaude` (with `cwd` defaulting to
 * `process.cwd()`), it starts Claude lazily on the first `send`/`stream`/`start` and
 * exposes `send`/`stream`/`close`. A thin wrapper over `startClaude` — no new behavior.
 */

import { SimpleSession } from "../core/simple/session.ts";
import type { StartClaudeOptions } from "../core/types.ts";
import { startClaude } from "./session.ts";
import type { ClaudeSession } from "./session-interface.ts";

/** Options for the ergonomic facade: `startClaude`'s options with an optional `cwd`. */
export type SimpleClaudeOptions = Omit<StartClaudeOptions, "cwd"> & { readonly cwd?: string };

export class SimpleClaudeSession extends SimpleSession<ClaudeSession> {
  private readonly options: SimpleClaudeOptions;

  constructor(options: SimpleClaudeOptions = {}) {
    super();
    this.options = options;
  }

  protected launch(): Promise<ClaudeSession> {
    return startClaude({ ...this.options, cwd: this.options.cwd ?? process.cwd() });
  }
}
