/** Native home-path composer releases queued sendMessage after closure (C-API-56, C-QUESTION-04). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type ElwoodQuestionEvent, startCodex } from "../../src/index.ts";
import { codexTty } from "../fixtures/trust-composer.ts";
import { captured, records } from "../unit/codex-questions/helpers.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  80, 100, 140,
])("C-API-56 C-QUESTION-04 closed queued questions release sendMessage at a live home-path composer (%i columns)", async (cols) => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd, initialSize: { cols, rows: 45 } });
  try {
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
    const events: ElwoodQuestionEvent[] = [];
    session.on("question", (event) => events.push(event));
    const native = records("async-records.json");
    const append = (items: readonly unknown[]) => {
      for (const item of items) appendFileSync(path, `${JSON.stringify(item)}\n`);
    };
    const render = async (text: string, visible = true) => {
      ptys[0]!.emitData(`\x1b[2J\x1b[H${codexTty(text, visible)}`);
      await session.terminal.settled();
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    append(native.slice(0, 3));
    const panel = captured("async-badge.txt").text;
    await render(panel.slice(panel.lastIndexOf("• Queued follow-up inputs")).trimEnd());
    await expect.poll(() => session.listQuestions()).toHaveLength(2);
    const before = [...ptys[0]!.writes];
    const queued = session.sendMessage("after the native question").then(
      () => "delivered",
      () => "rejected",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ptys[0]!.writes).toEqual(before);
    append(native.slice(-1));
    await expect.poll(() => session.listQuestions()).toEqual([]);
    expect(events.filter((event) => event.phase === "closed").map((event) => event.reason)).toEqual(
      ["unavailable", "unavailable"],
    );
    expect(ptys[0]!.writes).toEqual(before);

    const composer =
      "› Ask Codex to do anything\n\n  gpt-6.1 low · ~/.coal-harbor/workspaces/example";
    for (const unsafe of [
      `${composer}\nUnexpected trailing prose`,
      `${composer}\n1. Yes\n2. No`,
      `Would you like to run the following command?\n${composer}`,
      composer.replace("Ask Codex to do anything", "unfinished draft"),
      "› Ask Codex to do anything",
    ]) {
      await render(unsafe);
      expect(ptys[0]!.writes).toEqual(before);
    }
    await render(composer, false);
    expect(ptys[0]!.writes).toEqual(before);
    await render(composer);
    const expected = [...before, "\x1b[200~after the native question\x1b[201~", "\r"];
    await expect.poll(() => ptys[0]!.writes, { timeout: 1_000 }).toEqual(expected);
    await expect(queued).resolves.toBe("delivered");
    await render(composer);
    expect(ptys[0]!.writes).toEqual(expected);
  } finally {
    await session.kill();
  }
});
