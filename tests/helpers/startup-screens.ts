/**
 * Startup screen evidence for readiness-gate tests that do not exercise unrecognized
 * startup screens (PRD §5.4, C-ATTN-11): no native screens, every frame completed, and
 * reports dropped.
 */
export const noStartupScreens = {
  nativeStartupScreen: () => false,
  completed: () => true,
  report: () => undefined,
} as const;
