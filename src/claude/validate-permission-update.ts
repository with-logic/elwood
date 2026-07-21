/**
 * Runtime validation for Claude `updatedPermissions` (PermissionUpdate[]).
 *
 * Implements PRD §6.4: a `PermissionRequest` result may return
 * `updatedPermissions`, which is serialized to Claude. Each entry must match one
 * of the documented PermissionUpdate variants (see permissions.ts) rather than
 * merely being an array, so a malformed entry cannot slip through.
 */

import { isRecord, optionalString } from "./validate-shapes.ts";

const destinations = ["session", "localSettings", "projectSettings", "userSettings"] as const;
const ruleBehaviors = ["allow", "deny", "ask"] as const;
const permissionModes = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;

export function isPermissionUpdateArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isPermissionUpdate);
}

function isPermissionUpdate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isOneOf(value["destination"], destinations)) return false;
  const type = value["type"];
  if (type === "addRules" || type === "replaceRules" || type === "removeRules") {
    return isRulesUpdate(value);
  }
  if (type === "setMode") return isSetModeUpdate(value);
  if (type === "addDirectories" || type === "removeDirectories") return isDirectoriesUpdate(value);
  return false;
}

function isRulesUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return (
    keysAllowed(value, ["type", "rules", "behavior", "destination"]) &&
    isOneOf(value["behavior"], ruleBehaviors) &&
    Array.isArray(value["rules"]) &&
    value["rules"].every(isPermissionRule)
  );
}

function isSetModeUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return (
    keysAllowed(value, ["type", "mode", "destination"]) && isOneOf(value["mode"], permissionModes)
  );
}

function isDirectoriesUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return (
    keysAllowed(value, ["type", "directories", "destination"]) &&
    Array.isArray(value["directories"]) &&
    value["directories"].every((entry) => typeof entry === "string")
  );
}

function isPermissionRule(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    keysAllowed(value, ["toolName", "ruleContent"]) &&
    typeof value["toolName"] === "string" &&
    optionalString(value["ruleContent"])
  );
}

function keysAllowed(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}
