/**
 * A Codex session removes the copies Codex saved of the images pasted into it once its CLI
 * has exited (PRD §5.3, C-API-46), by stop, kill, teardown, or on its own, and nothing else:
 * an image the user named by its own path, and a copy its transcript never named, stay.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** A file this test makes, removed when it ends whether or not the session removed it. */
function made(path: string): string {
  writeFileSync(path, "png");
  onTestFinished(() => rmSync(path, { force: true }));
  return path;
}

const copyIn = (dir: string) => made(join(dir, `codex-clipboard-${randomUUID()}.png`));

test.each([
  "stop",
  "kill",
  "teardown",
  "natural exit",
] as const)("C-API-46 %s removes the copies of images pasted into the session", async (end) => {
  installFakes();
  const cwd = tempDir();
  const rollout = join(cwd, "rollout.jsonl");
  writeFileSync(rollout, "");
  const pasted = [copyIn(tmpdir()), copyIn(tmpdir())];
  const unnamed = copyIn(tmpdir());
  const userImage = made(join(cwd, "codex-clipboard-shot.png"));
  const session = await startCodex({ cwd });
  const seen: unknown[] = [];
  session.on("codex:transcript", (event) => seen.push(event.item));
  await becomeReady(session.elwoodSessionId, cwd, { transcript_path: rollout });
  const content = [...pasted, userImage].map((path) => ({ type: "local_image", path }));
  appendFileSync(
    rollout,
    `${JSON.stringify({
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "UserMessage", id: "m1", content } },
    })}\n`,
  );
  await expect.poll(() => seen.length).toBe(1);
  expect(pasted.every((path) => existsSync(path))).toBe(true); // nothing goes while it runs
  if (end === "natural exit") {
    ptys[0]!.emitExit({ exitCode: 0 });
    await expect.poll(() => session.status).toBe("exited");
  } else {
    await session[end]();
  }
  expect(pasted.filter((path) => existsSync(path))).toEqual([]);
  expect(existsSync(unnamed)).toBe(true);
  expect(existsSync(userImage)).toBe(true);
  await session.teardown();
});
