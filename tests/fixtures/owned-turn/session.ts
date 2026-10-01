/** Real adapter setup and native hook mechanics for owned-turn tests (C-API-48/56). */
import { vi } from "vitest";
import type { ElwoodAgentSession } from "../../../src/core/agent-session.ts";
import { ClaudeSession, type ClaudeSessionOptions, CodexSession } from "../../../src/index.ts";
import * as claude from "../../claude/helpers.ts";
import * as codex from "../../codex/helpers.ts";
import type { FakePty } from "../../helpers/fake-pty.ts";

export type Agent = "claude" | "codex";

export function prepareAdapter(agent: Agent) {
  const helper = agent === "claude" ? claude : codex;
  helper.installFakes();
  return { helper, cwd: helper.tempDir() };
}

type FixtureOptions = Pick<ClaudeSessionOptions, "initialSize" | "persona">;
type FacadeFixture<T> = ReturnType<typeof prepareAdapter> & { readonly facade: T };
export function createFacadeFixture(
  agent: "codex",
  options?: FixtureOptions,
): FacadeFixture<CodexSession>;
export function createFacadeFixture(
  agent: "claude",
  options?: FixtureOptions,
): FacadeFixture<ClaudeSession>;
export function createFacadeFixture(
  agent: Agent,
  options?: FixtureOptions,
): FacadeFixture<ClaudeSession | CodexSession>;
export function createFacadeFixture(agent: Agent, options: FixtureOptions = {}) {
  const { helper, cwd } = prepareAdapter(agent);
  const facade =
    agent === "claude"
      ? new ClaudeSession({ cwd, ...options })
      : new CodexSession({ cwd, ...options });
  return { helper, cwd, facade };
}

export function resetAdapters(): void {
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
}

export function nativeHooks(agent: Agent, session: ElwoodAgentSession, cwd: string, pty: FakePty) {
  const hook = (fields: Record<string, unknown>) =>
    pty.dispatchHook(session.elwoodSessionId, {
      session_id: `${agent}-1`,
      cwd,
      ...fields,
    });
  return {
    hook,
    ready: () =>
      agent === "codex"
        ? codex.becomeReady(session.elwoodSessionId, cwd)
        : hook({
            hook_event_name: "InstructionsLoaded",
            file_path: "/tmp/CLAUDE.md",
            memory_type: "Project",
            load_reason: "session_start",
          }),
    submit: (turn_id: string, prompt: string) =>
      hook({ hook_event_name: "UserPromptSubmit", turn_id, prompt }),
    stop: (turn_id: string, last_assistant_message = "") =>
      hook({ hook_event_name: "Stop", turn_id, stop_hook_active: false, last_assistant_message }),
  };
}
