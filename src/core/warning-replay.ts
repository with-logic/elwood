/**
 * Warning snapshot replay helpers for late event subscribers.
 * Implements PRD §5.7.
 */

import { activityFromWarning } from "./activity.ts";
import type { ElwoodWarningEvent } from "./types.ts";

export function replayWarningSnapshots(
  warnings: readonly ElwoodWarningEvent[],
  event: string,
  handler: (event: never) => unknown,
): void {
  if (event === "warning") {
    for (const warning of warnings) handler(warning as never);
  }
  if (event === "activity") {
    for (const warning of warnings) handler(activityFromWarning(warning) as never);
  }
}
