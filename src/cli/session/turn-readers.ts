/**
 * Per-agent turn readers for the headless CLI facade: Claude's boundary reader fails a turn the
 * agent rejected, and Codex binds its native turn identity. Implements PRD §5.8/§12A.2 and
 * C-CLI-28.
 */

import { claudeBoundarySignal } from "../../claude/hooks/stop-failure.ts";
import { codexTurnIdentity } from "../../codex/accepted-turn.ts";
import type { NativeTurnReader } from "../../core/simple/turn-identity.ts";
import { type BoundarySignalReader, defaultBoundarySignal } from "../../core/simple/turn-types.ts";
import type { CliAgent } from "../types.ts";

export type CliTurnReaders = {
  readonly boundary: BoundarySignalReader;
  readonly native: NativeTurnReader | undefined;
};

export const cliTurnReaders: Readonly<Record<CliAgent, CliTurnReaders>> = {
  claude: { boundary: claudeBoundarySignal, native: undefined },
  codex: { boundary: defaultBoundarySignal, native: codexTurnIdentity },
};
