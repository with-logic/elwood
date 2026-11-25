/**
 * Real agents answer with more rows than one screen holds. `readScreen()` returns the
 * live rows with the composer and the end of the reply under each CLI's default
 * renderer, and under its inline renderer it also returns scrollback and stays live
 * while the host is scrolled back. Once a stopped session's terminal is disposed, the
 * read rejects. Implements C-SCREEN-01 to C-SCREEN-03, C-E2E-02, and C-E2E-03.
 */
// biome-ignore-all lint/suspicious/noMisplacedAssertion: afterLongReply owns the checks both renderers share.

import assert from "node:assert/strict";
import test from "node:test";
import { type ElwoodScreen, startClaude, startCodex } from "../../src/index.ts";
import {
  cleanup,
  type E2eProject,
  type E2eSession,
  makeProject,
  skipIf,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";

const size = { cols: 100, rows: 30 };
const last = 80;
const prompt = `Reply with the integers from 1 to ${last}, each alone on its own line, and nothing else. Do not use tools.`;
/** The reply's rows carry a bullet on the first number and indentation on the rest. */
const shows = (rows: readonly string[], value: number) =>
  rows.some((row) => new RegExp(`^\\W*${value}$`).test(row));

/** Each CLI's composer glyph, and a launch that can select its inline renderer. */
const agents = {
  claude: {
    composer: "❯",
    start: ({ cwd, stateDir }: E2eProject, inline: boolean) =>
      startClaude({
        cwd,
        stateDir,
        initialSize: size,
        permissionMode: "bypassPermissions",
        autotrust: true,
        env: inline ? { CLAUDE_CODE_NO_FLICKER: "0" } : {},
      }),
  },
  codex: {
    composer: "›",
    start: ({ cwd, stateDir }: E2eProject, inline: boolean) =>
      startCodex({
        cwd,
        stateDir,
        initialSize: size,
        sandbox: "read-only",
        approvalPolicy: "never",
        autotrust: true,
        configOverrides: inline ? ['tui.alternate_screen="never"'] : [],
      }),
  },
} as const;

type Agent = keyof typeof agents;
type Renderer = "default" | "inline";
type IdleRead = (session: E2eSession, screen: ElwoodScreen) => Promise<void> | void;

/** Both CLIs park the terminal cursor in the composer, after its two-cell prompt glyph. */
const idleBelowReply = (agent: Agent, screen: ElwoodScreen) =>
  screen.lines[screen.cursor.y]?.startsWith(agents[agent].composer) === true &&
  shows(screen.lines, last);

/**
 * Runs one long reply, reads the idle screen with all scrollback, checks what every
 * renderer shares, hands the read to `check`, then stops and expects the read to reject.
 */
async function afterLongReply(
  agent: Agent,
  renderer: Renderer,
  t: test.TestContext,
  check: IdleRead,
) {
  const session = await agents[agent].start(makeProject(agent), renderer === "inline");
  const ready = () => (session.status === "ready" ? true : undefined);
  try {
    await waitFor(ready, "initial ready", 60_000);
    await session.sendMessage(prompt);
    await waitFor(
      async () => (shows((await session.readScreen()).lines, last) ? true : undefined),
      "the end of the reply on the live screen",
    );
    await waitFor(ready, "turn complete");
    const screen = await waitFor(async () => {
      const read = await session.readScreen({ scrollback: true });
      return idleBelowReply(agent, read) ? read : undefined;
    }, "the composer under the cursor below the reply");
    t.diagnostic(
      `${screen.buffer} buffer, ${screen.scrollback.length} scrollback rows, cursor ${JSON.stringify(screen.cursor)}`,
    );
    assert.equal(screen.cursor.visible, true, "the CLI leaves its cursor in the composer");
    assert.equal(screen.outputLost, false);
    assert.deepEqual(
      [screen.cols, screen.rows, screen.lines.length],
      [size.cols, size.rows, size.rows],
    );
    assert.deepEqual((await session.readScreen()).scrollback, [], "scrollback is opt-in");
    const nearest = await session.readScreen({ scrollback: 3 });
    assert.deepEqual(nearest.scrollback, screen.scrollback.slice(-3));
    await check(session, screen);
    await session.stop();
    await assert.rejects(session.readScreen(), { code: "session_not_running" });
  } finally {
    await cleanup(session);
  }
}

for (const agent of ["claude", "codex"] as const) {
  const run = { skip: skipIf(skipReason(agent), skipTurns), timeout: 240_000 };

  test(`C-SCREEN-01/02/03 real ${agent} screen text under its default renderer`, run, (t) =>
    afterLongReply(agent, "default", t, (_session, screen) => {
      assert.equal(screen.buffer, "alternate");
      // Records the CLI default: the alternate screen never has scrollback.
      assert.deepEqual(screen.scrollback, []);
    }),
  );

  test(`C-SCREEN-01/02/03 real ${agent} screen text under its inline renderer`, run, (t) =>
    afterLongReply(agent, "inline", t, async (session, screen) => {
      assert.equal(screen.buffer, "normal");
      assert.ok(shows(screen.scrollback, 1), "scrollback holds the start of the reply");
      // A host that scrolls its terminal handle back changes the snapshot, not the screen.
      session.terminal.xterm.scrollToTop();
      const scrolled = await session.readScreen();
      const viewport = session.terminal.snapshot().lines;
      assert.ok(shows(viewport, 1) && !shows(viewport, last), "the snapshot follows the host");
      assert.ok(idleBelowReply(agent, scrolled), "the screen stays live while scrolled back");
    }),
  );
}
