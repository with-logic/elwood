/**
 * Startup screen evidence for readiness-gate tests that do not exercise unrecognized
 * startup screens (PRD §5.4, C-ATTN-09): no native screens, every frame completed and
 * rendered, and reports dropped.
 */
export const noStartupScreens = {
  nativeStartupScreen: () => false,
  completed: () => true,
  rendering: () => false,
  report: () => undefined,
};
