/** Actual Codex adapter setup and explicit render phases for C-API-31/C-API-56/C-TRUST-01. */
import { vi } from "vitest";
import { codexEmptyInputFrame } from "../../../src/codex/screen/empty-input.ts";
import { codexInputStaged } from "../../../src/codex/screen/staged-input.ts";
import { startCodex } from "../../../src/index.ts";
import * as codex from "../../codex/helpers.ts";
import { codexSmallComposer, codexTty } from "../../fixtures/trust-composer.ts";

type Session = Awaited<ReturnType<typeof startCodex>>;
type Options = {
  readonly fakeTimers?: boolean;
  readonly autotrust?: boolean;
  readonly submit?: string;
};

/** Keep frame contents at the call site; only native composer substitution is shared. */
export function composerFrame(history: string, payload = "", idle = codexSmallComposer): string {
  return `${history}\n${payload ? idle.replace("› Ask Codex to do anything", `› ${payload}`) : idle}`;
}

function composerFixture(session: Session, pty: codex.FakePty) {
  return {
    session,
    pty,
    clear: (payload: string) =>
      payload
        ? codexInputStaged(session.terminal, payload)
        : codexEmptyInputFrame(session.terminal) !== undefined,
    emit(frame: string, payload?: string, synchronized = false) {
      const row = frame.split("\n").findLastIndex((line) => line.startsWith("›"));
      const cursor = payload === undefined ? "" : `\u001b[${row + 1};${payload.length + 3}H`;
      pty.emitData(
        `${synchronized ? "\u001b[?2026h" : ""}\u001b[2J\u001b[H${codexTty(frame)}${cursor}`,
      );
    },
    async settle(advanceMs?: number) {
      const rendered = session.terminal.settled();
      if (advanceMs !== undefined) await vi.advanceTimersByTimeAsync(advanceMs);
      await rendered;
    },
  };
}

/** No afterEach registration: each test retains its original reset order. */
export async function withComposerSession(
  options: Options,
  run: (fixture: ReturnType<typeof composerFixture>) => Promise<void>,
): Promise<void> {
  codex.installFakes();
  const cwd = codex.tempDir();
  const session = await startCodex({
    cwd,
    initialSize: { cols: 200, rows: 32 },
    ...(options.autotrust === undefined ? {} : { autotrust: options.autotrust }),
  });
  try {
    await codex.becomeReady(session.elwoodSessionId, cwd);
    if (options.fakeTimers) vi.useFakeTimers();
    if (options.submit) {
      const sent = session.sendPrompt(options.submit);
      await vi.advanceTimersByTimeAsync(200);
      await sent;
    }
    await run(composerFixture(session, codex.ptys[0]!));
  } finally {
    if (options.fakeTimers) vi.useRealTimers();
    await session.teardown();
  }
}
