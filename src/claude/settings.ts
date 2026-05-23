/**
 * Generates Claude session settings containing Elwood hook bridge wiring.
 * Implements PRD §4.3 and §6.1.
 */

import type { StartClaudeOptions } from "../core/types.ts";
import { claudeHookEventNames } from "./hooks.ts";

export type GeneratedSettingsInput = {
  readonly bridgeScriptPath: string;
  readonly options: Pick<StartClaudeOptions, "disallowedTools" | "settingsOverrides">;
  readonly timeoutSeconds: number;
};

export function generateClaudeSettings(
  input: GeneratedSettingsInput,
): Readonly<Record<string, unknown>> {
  return {
    ...input.options.settingsOverrides,
    hooks: generateHooks(input.bridgeScriptPath, input.timeoutSeconds),
    permissions: {
      ...permissionsFrom(input.options.settingsOverrides),
      deny: [...(input.options.disallowedTools ?? [])],
    },
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
        matcher: matcherFor(eventName),
        hooks: [
          {
            type: "command",
            command: process.execPath,
            args: [bridgeScriptPath],
            timeout,
          },
        ],
      },
    ];
  }
  return hooks;
}

function matcherFor(eventName: string): string | undefined {
  const toolEvents = new Set([
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionDenied",
  ]);
  if (toolEvents.has(eventName)) return "*";
  return undefined;
}

function permissionsFrom(
  overrides: StartClaudeOptions["settingsOverrides"],
): Record<string, unknown> {
  const permissions = overrides?.["permissions"];
  if (permissions && typeof permissions === "object" && !Array.isArray(permissions)) {
    return { ...(permissions as Record<string, unknown>) };
  }
  return {};
}
