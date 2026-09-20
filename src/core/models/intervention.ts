/** Private provenance for a picker generation revoked by human input (C-API-55, C-CODEX-14). */
import { elwoodError } from "../errors.ts";

const interventions = new WeakSet<Error>();

export function pickerIntervention(): Error {
  const error = elwoodError(
    "model_automation_failed",
    "Raw input replaced the model picker operation.",
  );
  interventions.add(error);
  return error;
}

export function isPickerIntervention(reason: unknown): boolean {
  return reason instanceof Error && interventions.has(reason);
}
