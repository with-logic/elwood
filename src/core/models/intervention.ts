/**
 * Private provenance for automation that raw caller input revoked: a picker operation
 * (C-API-55, C-CODEX-14), staged turn input, composer cleanup, or a native question answer.
 */
import { elwoodError } from "../errors.ts";

const interventions = new WeakSet<Error>();

export function callerInputIntervention(): Error {
  const error = elwoodError(
    "model_automation_failed",
    "Raw input replaced the model picker operation.",
  );
  interventions.add(error);
  return error;
}

export function isCallerInputIntervention(reason: unknown): boolean {
  return reason instanceof Error && interventions.has(reason);
}
