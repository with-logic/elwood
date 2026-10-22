/** Shared native question discovery layered over lifecycle (PRD §5.10). */
import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import type { QuestionAdapter } from "../../core/questions/adapter.ts";
import { SessionQuestions } from "../../core/questions/controller.ts";
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import type { TerminalReplayBuffer } from "../../core/terminal-replay.ts";
import type { PtyProcess } from "../../pty/types.ts";
import type { PersistedLoopDefinition } from "../../state/loop-store.ts";
import type { SessionRuntime } from "../../state/runtime-paths.ts";
import type { SessionRecord } from "../../state/store.ts";
import { SessionLifecycle } from "./lifecycle.ts";
import type { PickerInputOwnership } from "./picker-input.ts";
import type { SessionStatusEmitter } from "./status-wiring.ts";

export abstract class QuestionSessionBase extends SessionLifecycle {
  private readonly questions: SessionQuestions;
  protected constructor(
    agent: ElwoodAgentKind,
    record: SessionRecord,
    stateDir: string,
    runtime: SessionRuntime,
    pty: PtyProcess,
    input: PickerInputOwnership,
    events: SessionStatusEmitter,
    replay: TerminalReplayBuffer,
    loops: readonly PersistedLoopDefinition[],
  ) {
    super(agent, record, stateDir, runtime, pty, input, events, replay, loops);
    this.questions = new SessionQuestions(
      agent,
      record.elwoodSessionId,
      events,
      input.automated,
      input.signal.bind(input),
      this.closing.signal,
    );
  }
  protected configureQuestions(factory: (registry: QuestionRegistry) => QuestionAdapter): void {
    this.questions.configure(factory);
  }
  protected override isInputBlocked(): boolean {
    return super.isInputBlocked() || this.questions.blocksInput();
  }
  listQuestions() {
    return this.inSession(() => this.questions.list(), true);
  }
}
