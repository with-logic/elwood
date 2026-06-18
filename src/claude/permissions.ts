/**
 * Claude permission rule and update types used by hook responses.
 * Implements PRD §6.4.
 */

import type { ClaudeHookPermissionMode } from "./hook-names.ts";

export type PermissionRuleBehavior = "allow" | "deny" | "ask";
export type PermissionUpdateDestination =
  | "session"
  | "localSettings"
  | "projectSettings"
  | "userSettings";

export type PermissionRule = {
  readonly toolName: string;
  readonly ruleContent?: string;
};

export type PermissionUpdate =
  | {
      readonly type: "addRules" | "replaceRules" | "removeRules";
      readonly rules: readonly PermissionRule[];
      readonly behavior: PermissionRuleBehavior;
      readonly destination: PermissionUpdateDestination;
    }
  | {
      readonly type: "setMode";
      readonly mode: ClaudeHookPermissionMode;
      readonly destination: PermissionUpdateDestination;
    }
  | {
      readonly type: "addDirectories" | "removeDirectories";
      readonly directories: readonly string[];
      readonly destination: PermissionUpdateDestination;
    };
