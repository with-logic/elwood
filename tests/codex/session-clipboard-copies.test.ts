/**
 * A Codex session removes the copies Codex saved of the images pasted into it once its CLI
 * has exited (PRD §5.3, C-API-46), by stop, kill, teardown, or on its own, and nothing else:
 * an image the user named by its own path, and a copy its transcript never named, stay. A
 * copy first read by the final flush goes too, and one that cannot be removed does not stop
 * the session from finishing its exit.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/** The committed transcript record of a user message naming these image paths. */
const userMessage = (paths: readonly string[]) =>
  `${JSON.stringify({
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "UserMessage",
        id: "m1",
        content: paths.map((path) => ({ type: "local_image", path })),
      },
    },
  })}\n`;

/** A started Codex session reading `rollout` as its transcript, with every item it delivers. */
async function sessionReading(cwd: string, rollout: string) {
  writeFileSync(rollout, "");
  const session = await startCodex({ cwd });
  const seen: unknown[] = [];
  session.on("codex:transcript", (event) => seen.push(event.item));
  await becomeReady(session.elwoodSessionId, cwd, { transcript_path: rollout });
  return { session, seen };
}

test.each([
  "stop",
  "kill",
  "teardown",
  "natural exit",
] as const)("C-API-46 %s removes the copies of images pasted into the session", async (end) => {
  installFakes();
  const cwd = tempDir();
  const rollout = join(cwd, "rollout.jsonl");
  const pasted = [copyIn(tmpdir()), copyIn(tmpdir())];
  const unnamed = copyIn(tmpdir());
  const userImage = made(join(cwd, "codex-clipboard-shot.png"));
  const { session, seen } = await sessionReading(cwd, rollout);
  appendFileSync(rollout, userMessage([...pasted, userImage]));
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

test("C-API-46 a copy the final flush reads first is removed before the exit finishes", async () => {
  installFakes();
  const cwd = tempDir();
  const rollout = join(cwd, "rollout.jsonl");
  const pasted = copyIn(tmpdir());
  const { session, seen } = await sessionReading(cwd, rollout);
  const exits: { readonly exitCode: number; readonly copyLeft: boolean }[] = [];
  session.on("terminal:exit", (event) =>
    exits.push({ exitCode: event.exitCode, copyLeft: existsSync(pasted) }),
  );
  // The CLI exits in the same tick its last record lands, before any poll can read it.
  appendFileSync(rollout, userMessage([pasted]));
  ptys[0]!.emitExit({ exitCode: 0 });
  expect(seen).toHaveLength(1);
  expect(exits).toEqual([]); // the exit waits for the removal
  // The copy was already gone when `terminal:exit` reached its listeners.
  await expect.poll(() => exits).toEqual([{ exitCode: 0, copyLeft: false }]);
  expect(session.status).toBe("exited");
  await session.teardown();
});

test("C-API-46 a copy that cannot be removed is left, reported once, and the exit still finishes", async () => {
  installFakes();
  const cwd = tempDir();
  const rollout = join(cwd, "rollout.jsonl");
  // Directories under copy names: unlinking one fails with EPERM or EISDIR, not ENOENT.
  const stuckCopy = () => join(tmpdir(), `codex-clipboard-${randomUUID()}.png`);
  const stuck = [stuckCopy(), stuckCopy()] as const;
  for (const path of stuck) {
    mkdirSync(path);
    onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  }
  const pasted = copyIn(tmpdir());
  const { session, seen } = await sessionReading(cwd, rollout);
  const events: string[] = [];
  session.on("warning", () => {
    throw new Error("a warning listener bug"); // must not keep the exit from finishing
  });
  session.on("warning", (event) =>
    events.push(`${event.code}${"errorCode" in event ? ` ${event.errorCode}` : ""}`),
  );
  session.on("terminal:exit", () => events.push("terminal:exit"));
  appendFileSync(rollout, userMessage([stuck[0], pasted, stuck[1]]));
  await expect.poll(() => seen.length).toBe(1);
  await session.stop();
  expect(session.status).toBe("stopped");
  expect(stuck.every((path) => existsSync(path))).toBe(true);
  expect(existsSync(pasted)).toBe(false); // the failure did not stop the next removal
  // One content-free warning for the session, before its exit.
  expect(events).toEqual([
    expect.stringMatching(/^image_copy_removal_failed (EPERM|EISDIR)$/),
    "terminal:exit",
  ]);
  await session.teardown();
});

test("C-API-46 a named copy already gone at exit is not a failure", async () => {
  installFakes();
  const cwd = tempDir();
  const rollout = join(cwd, "rollout.jsonl");
  const pasted = copyIn(tmpdir());
  const { session, seen } = await sessionReading(cwd, rollout);
  const warnings: string[] = [];
  session.on("warning", (event) => warnings.push(event.code));
  appendFileSync(rollout, userMessage([pasted]));
  await expect.poll(() => seen.length).toBe(1);
  rmSync(pasted);
  await session.stop();
  expect(warnings).toEqual([]);
  await session.teardown();
});
