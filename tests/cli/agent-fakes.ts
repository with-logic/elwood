/**
 * Deterministic agent detectors for CLI request tests, so no unit test asks the
 * real login shell which agents are installed (PRD C-CLI-21).
 */

import type { AgentDetector } from "../../src/cli/request/agent-detect.ts";
import { CliValidationError } from "../../src/cli/types.ts";

export const detectCodex: AgentDetector = () => Promise.resolve("codex");
export const detectClaude: AgentDetector = () => Promise.resolve("claude");
export const detectNothing: AgentDetector = () =>
  Promise.reject(new CliValidationError("no_agent_found", "no agent (test)"));
