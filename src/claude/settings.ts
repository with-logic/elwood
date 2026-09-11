/**
 * Generates Claude session settings containing Elwood hook bridge wiring.
 * Implements PRD §4.3 and §6.1.
 */

import type { StartClaudeOptions } from "../core/types.ts";
import { hookCommand } from "../runtime/hook-command.ts";
import { claudeHookEventNames } from "./hooks/index.ts";
import { isToolHookEventName } from "./hooks/tool-events.ts";

export type GeneratedSettingsInput = {
  readonly bridgeScriptPath: string;
  readonly options: Pick<StartClaudeOptions, "settingsOverrides">;
  /** The CLI-side per-hook timeout written into the settings (see session/runtime.ts). */
  readonly timeoutSeconds: number;
};

/** Caller overrides (including any `permissions`) pass through; Elwood adds only `hooks`. */
export function generateClaudeSettings(
  input: GeneratedSettingsInput,
): Readonly<Record<string, unknown>> {
  return {
    ...input.options.settingsOverrides,
    hooks: generateHooks(input.bridgeScriptPath, input.timeoutSeconds),
  };
}

function generateHooks(
  bridgeScriptPath: string,
  timeout: number,
): Readonly<Record<string, unknown>> {
  const hooks: Record<string, unknown> = {};
  for (const eventName of claudeHookEventNames) {
    hooks[eventName] = [
      {
        // Tool events need a matcher; "*" routes every tool through the bridge.
        ...(isToolHookEventName(eventName) ? { matcher: "*" } : {}),
        hooks: [
          {
            type: "command",
            command: hookCommand(bridgeScriptPath),
            timeout,
          },
        ],
      },
    ];
  }
  return hooks;
}
