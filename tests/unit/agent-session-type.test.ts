/**
 * Conformance tests for the adapter-neutral session type.
 * Covers PRD §5.7 and C-API-27.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  type ClaudeEventMap,
  type CodexEventMap,
  type ElwoodAgentSession,
  type ElwoodCommonEventMap,
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

  test("C-API-27 both adapters satisfy the common session type", async () => {
    const cwd = tempDir();
    installClaudeFakes();
    const claude: ElwoodAgentSession = await startClaude({ cwd });
    expect(claude.status).toBe("running");
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
      await session.resize({ cols: 100, rows: 30 });
      await session.stop();
    }
  });
});
