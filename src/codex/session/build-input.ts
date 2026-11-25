/** Inputs for preparing a Codex session launch (PRD §5.7, §8). */
import type { SessionRuntime } from "../../state/runtime-paths.ts";
import type { SessionRecord } from "../../state/store.ts";
import type { CodexPreflightWarning } from "../preflight.ts";
import type { CodexLaunchOptions } from "../pty.ts";

export type BuildCodexSessionInput = {
  readonly record: SessionRecord;
  readonly stateDir: string;
  readonly runtime: SessionRuntime;
  readonly options: CodexLaunchOptions;
  readonly resumed: boolean;
  readonly activate: () => void;
  readonly preflightWarning: CodexPreflightWarning | undefined;
};
