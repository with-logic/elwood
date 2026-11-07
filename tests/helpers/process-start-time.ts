/** Shared second-resolution process-start precondition for real shutdown tests (C-LIFE-10). */
import { processStartTimeUncertaintyMs } from "../../src/runtime/shutdown/detached-sweep/leader-observation.ts";

const PROCESS_START_SCHEDULING_MARGIN_MS = 100;

/** Cross ps’s timestamp uncertainty interval with room for scheduling delay. */
export const DISTINCT_PROCESS_START_DELAY_MS =
  processStartTimeUncertaintyMs() + PROCESS_START_SCHEDULING_MARGIN_MS;
