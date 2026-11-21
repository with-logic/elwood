/** Deliver normalized Codex transcript quota to the session snapshot (PRD §5.12). */
import type { TypedEmitter } from "../../events/emitter.ts";
import type { SessionStatsReader } from "../../runtime/session/stats.ts";
import { codexTranscriptWindows } from "../usage/windows.ts";
import type { CodexEventMap } from "./types.ts";

export function bindCodexQuotaStats(
  session: SessionStatsReader,
  emitter: TypedEmitter<CodexEventMap>,
): void {
  emitter.on("activity", ({ rateLimits }) => {
    if (rateLimits === undefined) return;
    const receivedAtMs = Date.now();
    session.observeQuota(
      codexTranscriptWindows(rateLimits),
      rateLimits.recordedAt === undefined
        ? receivedAtMs
        : Math.min(receivedAtMs, Date.parse(rateLimits.recordedAt)),
    );
  });
}
