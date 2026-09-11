/**
 * Runtime validation for Claude `updatedPermissions` (PermissionUpdate[]).
 *
 * Implements PRD §6.4: a `PermissionRequest` result may return
 * `updatedPermissions`, which is serialized to Claude. Each entry must match one
 * of the documented PermissionUpdate variants (see permissions.ts) rather than
 * merely being an array, so a malformed entry cannot slip through.
 */

import { isOneOf, isRecord, optionalString } from "../../core/predicates.ts";
import { claudeHookPermissionModes } from "../hooks/names.ts";
import type {
  PermissionRuleBehavior,
  PermissionUpdate,
  PermissionUpdateDestination,
} from "../permissions.ts";

// `Exact<A, B>` resolves to `A` only when A and B are mutually assignable; otherwise
// to `never`, so `const _c: Exact<Tuple, Union> = tuple` fails to compile if the
// runtime allowlist and the public union drift apart in EITHER direction. This is
// what compile-couples every allowlist below to its canonical PermissionUpdate type,
// so a newly-added valid member can't compile while being rejected at runtime (§6.4).
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? A : never) : never;

const destinations = ["session", "localSettings", "projectSettings", "userSettings"] as const;
const ruleBehaviors = ["allow", "deny", "ask"] as const;
const updateTypes = [
  "addRules",
  "replaceRules",
  "removeRules",
  "setMode",
  "addDirectories",
  "removeDirectories",
] as const;

// Bidirectional exactness guards (see Exact above). Each stops compiling the moment
// its allowlist and the public union disagree.
const _destinationsExact: Exact<(typeof destinations)[number], PermissionUpdateDestination> =
  destinations[0];
const _behaviorsExact: Exact<(typeof ruleBehaviors)[number], PermissionRuleBehavior> =
  ruleBehaviors[0];
const _typesExact: Exact<(typeof updateTypes)[number], PermissionUpdate["type"]> = updateTypes[0];
void _destinationsExact;
void _behaviorsExact;
void _typesExact;

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
    keysAllowed(value, ["type", "mode", "destination"]) &&
    isOneOf(value["mode"], claudeHookPermissionModes)
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
