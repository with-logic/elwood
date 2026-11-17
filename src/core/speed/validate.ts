/** Before-spawn validation of explicit speed choices. Implements C-SPEED-01. */
import { elwoodError } from "../errors.ts";
import { codexServiceTier, codexServiceTiers } from "./types.ts";

export function validateSpeed(agent: "claude" | "codex", value: unknown): void {
  if (value === undefined) return;
  const valid = agent === "claude" ? typeof value === "boolean" : codexServiceTier(value) === value;
  if (valid) return;
  const option = agent === "claude" ? "fastMode" : "serviceTier";
  const values = agent === "claude" ? [true, false] : codexServiceTiers;
  throw elwoodError("invalid_speed", `${agent} ${option} must be one of: ${values.join(", ")}.`, {
    agent,
    option,
    valid: [...values],
    value,
  });
}
