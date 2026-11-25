/** Verify Codex workspace trust confirmation across synchronized output (C-ATTN-07). */
import { afterEach, expect, test, vi } from "vitest";
import { subscribeRender } from "../../src/terminal/cursor.ts";
import { codexCommandApprovalRender } from "../fixtures/codex-command-approval-render.ts";
import { nativeDialogs } from "../fixtures/codex-native-dialog-renders.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { resetFakes } from "./helpers.ts";
import { menu, setupWorkspaceAnswer } from "./workspace-trust-answer-helpers.ts";
import { clear } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);

const startSync = "\x1b[?2026h";
const endSync = "\x1b[?2026l";
const hiddenCursorSyncEnd = `\x1b[?25l${endSync}`;
const composer = codexTty(codexComposer);
const replacementLayout = "folder-access-no-hook-bypass";
// The native dialog render captures use CUP followed by ED to start a repaint.
const startNativePaint = "\x1b[1;1H\x1b[J";

test("C-ATTN-07 the 0.155.1 approval capture ends with the native synchronization checkpoint", () => {
  expect(codexCommandApprovalRender.endsWith(hiddenCursorSyncEnd)).toBe(true);
});

type Fixture = Awaited<ReturnType<typeof setupWorkspaceAnswer>>;
async function observeAnswer(paint: (fixture: Fixture) => Promise<void>) {
  const fixture = await setupWorkspaceAnswer();
  const { session, pty, request } = fixture;
  try {
    const [choice] = request.choices;
    if (!choice) throw new Error("Expected a verified trust choice");
    const answer = session.answerDialog(request.id, choice.id);
    const outcome = answer.catch((error: unknown) => error);
    await vi.waitFor(() => {
      if (!pty.writes.includes("\r")) throw new Error("Expected the native confirmation key");
    });
    await paint(fixture);
    return { outcome: await outcome, writes: pty.writes };
  } finally {
    await session.teardown();
  }
}

test("C-ATTN-07 a separately rendered synchronized native replacement rejects with frame", async () => {
  const { outcome, writes } = await observeAnswer(async ({ cwd, render }) => {
    await render(`${startSync}${menu(cwd, replacementLayout)}`);
    await render(`${composer}${endSync}`);
  });
  expect(writes).toEqual(["\r"]);
  expect(outcome).toMatchObject({
    code: "dialog_answer_failed",
    details: { category: "frame" },
  });
});

test("C-ATTN-07 host output during a synchronized native replacement aborts the answer", async () => {
  const { outcome, writes } = await observeAnswer(async ({ cwd, session, render }) => {
    const unsubscribe = subscribeRender(session.terminal, () => {
      unsubscribe();
      session.terminal.xterm.write("\x1b[0m");
    });
    await render(`${startSync}${menu(cwd, replacementLayout)}`);
    await render(`${composer}${endSync}`);
  });
  expect(writes).toEqual(["\r"]);
  expect(outcome).toMatchObject({
    code: "dialog_answer_failed",
    details: { category: "aborted" },
  });
});

test.each([
  ...nativeDialogs
    .filter(({ gate }) => gate === "workspace")
    .map(({ version, paint }) => ({
      boundary: `Codex ${version} viewport erase`,
      beforeComposer: paint.slice(0, startNativePaint.length),
      afterComposer: endSync,
    })),
  {
    boundary: "end of synchronization",
    beforeComposer: `${codexCommandApprovalRender.slice(-hiddenCursorSyncEnd.length)}${startNativePaint}`,
    afterComposer: "",
  },
])("C-ATTN-07 observes a coalesced replacement before $boundary", async ({
  beforeComposer,
  afterComposer,
}) => {
  const { outcome, writes } = await observeAnswer(async ({ cwd, pty, session }) => {
    pty.emitData(
      `${startSync}${clear}${menu(cwd, replacementLayout)}${beforeComposer}${composer}${afterComposer}`,
    );
    await session.terminal.settled();
  });
  expect(writes).toEqual(["\r"]);
  expect(outcome).toMatchObject({
    code: "dialog_answer_failed",
    details: { category: "frame" },
  });
});

test("C-ATTN-07 a coalesced same-menu repaint can still confirm at the composer", async () => {
  const { outcome, writes } = await observeAnswer(async ({ cwd, pty, session }) => {
    pty.emitData(`${startSync}${clear}${menu(cwd)}${startNativePaint}${composer}${endSync}`);
    await session.terminal.settled();
  });
  expect(writes).toEqual(["\r"]);
  expect(outcome).toBeUndefined();
});

test("C-ATTN-07 a complete synchronized menu disclosing another folder prevents acknowledgement", async () => {
  const { outcome, writes } = await observeAnswer(async ({ cwd, pty, session }) => {
    pty.emitData(
      `${startSync}${clear}${menu(`${cwd}-other`)}${startNativePaint}${composer}${endSync}`,
    );
    await session.terminal.settled();
  });
  expect(writes).toEqual(["\r"]);
  expect(outcome).toMatchObject({
    code: "dialog_answer_failed",
    details: { category: "frame" },
  });
});

test("C-ATTN-07 an incomplete synchronized disclosure cannot veto a settled composer", async () => {
  const { outcome, writes } = await observeAnswer(async ({ cwd, pty, session }) => {
    const incomplete = menu(cwd).replace(cwd, "");
    pty.emitData(`${startSync}${clear}${incomplete}${startNativePaint}${composer}${endSync}`);
    await session.terminal.settled();
  });
  expect(writes).toEqual(["\r"]);
  expect(outcome).toBeUndefined();
});
