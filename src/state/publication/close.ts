/** Contain native close failures and schedule bounded Node diagnostics (PRD §8.1). */
import { closeSync } from "node:fs";
import { errnoCode } from "../../core/errors.ts";

let warned = false;
type CloseWarningCode = "EBADF" | "EINTR" | "EIO" | "UnknownError";

/**
 * Native close failures do not escape disposal or mask a primary error. Never retry an
 * ambiguous close: its descriptor number may already have been released. Warning delivery
 * and host warning-listener exceptions retain Node's normal asynchronous semantics.
 */
export function closePublicationDirectory(fd: number): void {
  try {
    closeSync(fd);
  } catch (error) {
    if (warned) return;
    warned = true;
    const code = errnoCode(error);
    const warningCode: CloseWarningCode =
      code === "EBADF" || code === "EINTR" || code === "EIO" ? code : "UnknownError";
    process.emitWarning("Could not dispose a launch state directory descriptor.", {
      type: "ElwoodStateDirectoryCloseWarning",
      code: warningCode,
    });
  }
}
