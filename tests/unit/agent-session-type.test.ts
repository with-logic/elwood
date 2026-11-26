/**
 * Conformance tests for the adapter-neutral session type.
 * Covers PRD §5.7 and C-API-27.
 */

import { afterEach, describe, expect, expectTypeOf, test } from "vitest";
import {
  type ClaudeEventMap,
  type ClaudeSession,
  type CodexEventMap,
  type CodexSession,
  type ElwoodAgentSession,
  type ElwoodCommonEventMap,
  type ElwoodDialogRequest,
  type ElwoodEventMap,
  type ElwoodLoopEvent,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import {
  installFakes as installClaudeFakes,
  resetFakes as resetClaudeFakes,
  tempDir,
} from "../claude/helpers.ts";
import {
  ptys as codexPtys,
  installFakes as installCodexFakes,
  resetFakes as resetCodexFakes,
} from "../codex/helpers.ts";

afterEach(() => {
  resetClaudeFakes();
  resetCodexFakes();
});

describe("ElwoodAgentSession", () => {
  test("C-LOOP-01/C-LOOP-16 common events expose the redacted loop union", () => {
    const event: ElwoodCommonEventMap["loop"] = {
      kind: "cancelled",
      loopId: "loop-1",
      at: 1,
      reason: "caller",
    };
    const sameEvent: ElwoodLoopEvent = event;
    const claudeEvent: ClaudeEventMap["loop"] = sameEvent;
    const deprecatedAlias: ElwoodEventMap["loop"] = claudeEvent;
    const codexEvent: CodexEventMap["loop"] = sameEvent;
    void [deprecatedAlias, codexEvent]; // the assignments above are the (compile-time) assertion
  });

  test("C-API-27 listDialogs exposes shared and adapter-specific request types", () => {
    expectTypeOf<ReturnType<ElwoodAgentSession["listDialogs"]>>().toEqualTypeOf<
      Promise<readonly ElwoodDialogRequest<"claude" | "codex">[]>
    >();
    expectTypeOf<ReturnType<ClaudeSession["listDialogs"]>>().toEqualTypeOf<
      Promise<readonly ElwoodDialogRequest<"claude">[]>
    >();
    expectTypeOf<ReturnType<CodexSession["listDialogs"]>>().toEqualTypeOf<
      Promise<readonly ElwoodDialogRequest<"codex">[]>
    >();
  });

  test("C-CLAUDE-26 narrowing a shared request's agent exposes only Claude's hooks disclosure", () => {
    type Shared = ElwoodDialogRequest<"claude" | "codex">;
    expectTypeOf<Extract<Shared, { readonly agent: "claude" }>>().toEqualTypeOf<
      ElwoodDialogRequest<"claude">
    >();
    expectTypeOf<Extract<Shared, { readonly agent: "claude" }>["disclosesHooks"]>().toBeBoolean();
    expectTypeOf<Extract<Shared, { readonly agent: "codex" }>>().not.toHaveProperty(
      "disclosesHooks",
    );
    // Narrowing in code compiles only because the shared request is a discriminated union.
    const disclosure = (request: Shared) =>
      request.agent === "claude" ? request.disclosesHooks : undefined;
    expectTypeOf(disclosure).returns.toEqualTypeOf<boolean | undefined>();
  });

  test("C-API-27 both adapters satisfy the common session type", async () => {
    const cwd = tempDir();
    installClaudeFakes();
    const claude: ElwoodAgentSession = await startClaude({ cwd });
    expect(claude.status).toBe("running");
    expect(await claude.listDialogs()).toEqual([]);
    const statuses: string[] = [];
    const unsubscribe = claude.on("status", (event) => statuses.push(event.status));
    await claude.stop();
    unsubscribe();
    expect(statuses).toContain("stopped");
    resetClaudeFakes();

    installCodexFakes();
    const codex: ElwoodAgentSession = await startCodex({ cwd: tempDir() });
    codexPtys[0]?.emitData("codex rendered\r\n\u203a ");
    // The shared surface drives either adapter without adapter generics.
    const sessions: readonly ElwoodAgentSession[] = [codex];
    for (const session of sessions) {
      expect(typeof session.elwoodSessionId).toBe("string");
      expect(await session.listDialogs()).toEqual([]);
      await session.resize({ cols: 100, rows: 30 });
      await session.stop();
    }
  });
});
