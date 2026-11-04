/** Nonfatal, bounded diagnostics for publication descriptor disposal (PRD §8.1). */
import { closeSync } from "node:fs";
import { errnoCode } from "../../core/errors.ts";

let warned = false;
const closeCodes: ReadonlySet<string> = new Set(["EBADF", "EINTR", "EIO"]);

/** Never retry: a failed native close may already have released its descriptor number. */
export function closePublicationDirectory(fd: number): void {
  try {
    closeSync(fd);
  } catch (error) {
    if (warned) return;
    warned = true;
    const code = errnoCode(error);
    process.emitWarning("Could not dispose a launch state directory descriptor.", {
      type: "ElwoodStateDirectoryCloseWarning",
      code: code && closeCodes.has(code) ? code : "UnknownError",
    });
  }
}
