/** Correlated Claude hook decisions gate live discovery (PRD §5.10). */
import { AgentSessionBase } from "../../runtime/session/base.ts";
import type { ClaudeHookEvent, ClaudeHookResult } from "../hooks/index.ts";
import { ClaudeQuestionHookGate } from "../questions/hook-decisions.ts";
import { ClaudeQuestionAdapter } from "../questions/index.ts";

export abstract class ClaudeQuestionsSession extends AgentSessionBase {
  // ClaudeSessionImpl configures synchronously before the bridge can obtain the instance.
  private questionHookGate!: ClaudeQuestionHookGate;
  protected configureClaudeQuestions(): void {
    this.configureQuestions((registry) => {
      const gate = new ClaudeQuestionHookGate(new ClaudeQuestionAdapter(registry));
      this.questionHookGate = gate;
      return gate;
    });
  }
  resolveQuestionHook(event: ClaudeHookEvent, result: ClaudeHookResult): void {
    this.questionHookGate.resolveHookResult(event, result);
  }
}
