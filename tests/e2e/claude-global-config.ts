/**
 * The global config the e2e suite's private Claude config dir starts from (PRD §12,
 * C-E2E-23, `claude-home.ts`): the user's own, so first-run screens and notices they have
 * already dismissed stay dismissed, minus the keys that would tie a suite run to the
 * user's own history.
 */

import { isRecord } from "../../src/core/predicates.ts";

/** Global-config keys the private copy leaves out. */
const droppedKeys = new Set([
  // One entry per directory Claude ever ran in.
  "projects",
  // No user MCP server starts.
  "mcpServers",
  // The bypass-permissions dialog always renders for the e2e to answer.
  "bypassPermissionsModeAccepted",
  // Claude's fullscreen crash tracking. Claude 2.1.332 starts on its main-screen renderer
  // when it finds a fullscreen launch whose PID died before it was healthy, so a user
  // session that died early would change the renderer every suite Claude starts with.
  "fullscreenBootPending",
  "fullscreenBootStrikes",
  "fullscreenAutoDisabled",
]);

/**
 * The private `.claude.json` text made from a source global config, usually the user's,
 * with the dropped keys left out and onboarding marked complete.
 */
export function privateGlobalConfig(sourceGlobalConfig: Readonly<Record<string, unknown>>): string {
  const kept = Object.entries(sourceGlobalConfig).filter(([key]) => !droppedKeys.has(key));
  return JSON.stringify({ ...Object.fromEntries(kept), hasCompletedOnboarding: true });
}

/** The global config `text` read from `path` holds; throws naming `path` unless it is an object. */
export function parseGlobalConfig(text: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${path} does not hold a JSON object`);
  return parsed;
}
