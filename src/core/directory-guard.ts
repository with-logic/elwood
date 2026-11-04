/** Private evidence for a child-side workspace refusal (C-API-61, PRD §9.1). */
import { randomBytes } from "node:crypto";

/** Internal child refusal, never a public Elwood CLI exit status. */
export const directoryGuardExitCode = 96;
/** A fixed prefix with a private parent-process token avoids confusing an agent exit. */
export const directoryGuardStopMarker = `elwood-directory-guard-${randomBytes(8).toString("hex")}`;
export const directoryGuardStoppedReason =
  "the working directory (`cwd`) failed its child-side identity check";
export type DirectoryGuardObservation = {
  readonly cwd: string;
  readonly sawMarker: () => boolean;
};
