/** Supported adapter preflight fixtures for update outcomes (PRD §9.2, C-LIFE-09/11). */
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";

export const updateAdapters = [
  ["claude", "2.1.144", preflightClaude],
  ["codex", "codex-cli 0.150.0", preflightCodex],
] as const;
