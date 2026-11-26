/**
 * A fake-PTY Claude session running turn `p1` with guidance written into it, for the guidance
 * hold tests (PRD §6.5, C-HOOK-24).
 */
import type { ClaudeHookEventFor, ClaudeHookResultForEvent } from "../../src/index.ts";
import { startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, showComposer, tempDir } from "./helpers.ts";

export type SubmitResult =
  | ClaudeHookResultForEvent<ClaudeHookEventFor<"UserPromptSubmit">>
  | undefined;
type StopResult = ClaudeHookResultForEvent<ClaudeHookEventFor<"Stop">> | undefined;

export const holdReasons = {
  queued: "ignored: Claude runs the guidance queued at this Stop as a new turn",
  screening: "ignored: a UserPromptSubmit handler is still screening guidance",
  unheard: "ignored: input written into the turn has not fired its UserPromptSubmit",
} as const;

type GuidanceHandlers = {
  /** Answers the `UserPromptSubmit` for guidance; the turn's own prompt is always allowed. */
  readonly screen?: (prompt: string) => Promise<SubmitResult>;
  readonly stop?: () => Promise<StopResult>;
  readonly hookTimeoutMs?: number;
};

/** A session running prompt `p1`, with guidance `note` written into that turn. */
export async function runningWithGuidance(handlers: GuidanceHandlers = {}) {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({
    cwd,
    ...(handlers.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: handlers.hookTimeoutMs }),
    hooks: {
      UserPromptSubmit: (event) =>
        event.prompt === "busy" ? undefined : handlers.screen?.(event.prompt),
      ...(handlers.stop === undefined ? {} : { Stop: handlers.stop }),
    },
  });
  const hook = (hook_event_name: string, fields: Record<string, unknown> = {}) =>
    ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name,
      session_id: "claude-1",
      cwd,
      ...fields,
    });
  const submit = (prompt: string) => hook("UserPromptSubmit", { prompt_id: "p1", prompt });
  const stop = (promptId: string) => hook("Stop", { prompt_id: promptId, stop_hook_active: false });
  showComposer();
  await session.sendPrompt("busy");
  await submit("busy");
  await session.sendGuidance("note");
  return { session, hook, submit, stop };
}

/** The full `queued_turn_unconfirmed` warning a session reports at the hang limit. */
export const queuedTurnUnconfirmed = (elwoodSessionId: string) => ({
  elwoodSessionId,
  agent: "claude",
  source: "lifecycle",
  code: "queued_turn_unconfirmed",
  severity: "warning",
  message:
    "Claude did not finish the guidance queued at its Stop within the limit, so Elwood released that Stop.",
  raw: "queued_turn_unconfirmed",
});

const frame = (text: string) => `\u001b[2J\u001b[H${text}`;

/** Claude paints its working footer, then the idle composer: one rendered turn end. */
export async function paintTurnEnd(session: { terminal: { settled(): Promise<void> } }) {
  ptys[0]!.emitData(frame("esc to interrupt"));
  await session.terminal.settled();
  ptys[0]!.emitData(frame(claudeTty(claudeComposer)));
  await session.terminal.settled();
}

export const lastDecisionReason = (session: { statusDecisions(): readonly { reason: string }[] }) =>
  session.statusDecisions().at(-1)?.reason;
