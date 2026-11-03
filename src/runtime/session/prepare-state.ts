/** Preserve typed adapter startup failures for state preparation (PRD §9.1/§10, C-ERR-08). */
import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import { causeDetails, ElwoodError, elwoodError } from "../../core/errors.ts";
import { prepareStateDir, type StateDirSetup } from "../../state/store.ts";

/** State errors retain their identity; native I/O errors gain the adapter startup contract. */
export function prepareLaunchState(
  agent: ElwoodAgentKind,
  stateDir: string,
  setup: StateDirSetup,
): void {
  try {
    prepareStateDir(stateDir, setup);
  } catch (error) {
    if (error instanceof ElwoodError) throw error;
    throw elwoodError(
      `${agent}_start_failed`,
      `Could not prepare ${agent} session state.`,
      causeDetails(error),
    );
  }
}
