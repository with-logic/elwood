/**
 * The global config the e2e suite's private Claude config dir starts from (PRD §12,
 * C-E2E-23, `claude-home.ts`): the user's own, so first-run screens and notices they have
 * already dismissed stay dismissed, minus the keys that would tie a suite run to the
 * user's own history.
 */

/** User global-config keys the private copy leaves out. */
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

/** The private `.claude.json` text for a user global config, onboarding marked complete. */
export function privateGlobalConfig(user: Readonly<Record<string, unknown>>): string {
  const kept = Object.entries(user).filter(([key]) => !droppedKeys.has(key));
  return JSON.stringify({ ...Object.fromEntries(kept), hasCompletedOnboarding: true });
}
