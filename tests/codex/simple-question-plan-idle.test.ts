/** Native Plan footer must release the accepted Stop collector (PRD §5.8, C-QUESTION-02). */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { TerminalSnapshot } from "../../src/terminal/headless.ts";
import { createFacadeFixture, nativeHooks } from "../fixtures/owned-turn/session.ts";
import { codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, ptys, resetFakes } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});
test("C-API-48 C-QUESTION-02 a committed final and matching Stop drain after native Plan idle", async () => {
  const { cwd, facade } = createFacadeFixture("codex", { initialSize: { cols: 140, rows: 45 } });
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  const plan = JSON.parse(
    readFileSync(
      new URL("../fixtures/codex-0.163.0/questions/plan-completed.json", import.meta.url),
      "utf8",
    ),
  ) as TerminalSnapshot;
  let result: Promise<unknown> | undefined;
  let settled = false;
  try {
    const live = await facade.start();
    await becomeReady(live.elwoodSessionId, cwd, { transcript_path: path });
    const pty = ptys[0]!;
    const { submit, stop } = nativeHooks("codex", live, cwd, pty);
    vi.useFakeTimers();
    result = facade.send("modal turn", { timeoutMs: 10_000 }).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(pty.writes).toContain("\r");
    await submit("owned-plan", "modal turn");
    appendFileSync(
      path,
      `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "ELWOOD_PLAN_FINAL" }] } })}\n`,
    );
    await stop("owned-plan", "ELWOOD_PLAN_FINAL");
    expect(live.status).toBe("ready");
    expect(settled).toBe(false);
    pty.emitData(`\x1b[2J\x1b[H${codexTty(plan.text)}`);
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(true);
    expect(await result).toBe("ELWOOD_PLAN_FINAL");
  } finally {
    vi.useRealTimers();
    await facade.kill();
    await result;
  }
});
