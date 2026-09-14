/** Typed model probe outcomes shared by single and combined listings (PRD §12A.10, C-CLI-26). */
import type { AgentModelOption } from "../../core/models/rows.ts";
import type { CliError } from "../output/types.ts";
import type { CliAgent } from "../types.ts";

export type ModelsResult =
  | { readonly agent: CliAgent; readonly models: readonly AgentModelOption[] }
  | { readonly agent: CliAgent; readonly error: CliError; readonly exitCode: number };
