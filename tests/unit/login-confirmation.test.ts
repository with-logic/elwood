/** Native login acknowledgement safety and readiness ordering (PRD §5.3, C-API-43). */
import { afterEach, expect, test, vi } from "vitest";
import {
  acknowledgeLoginSuccess,
  isClaudeLoginSuccessDialog,
} from "../../src/claude/login/confirmation.ts";
import type { LoginIo } from "../../src/claude/login/driver.ts";
import { runSessionLogin } from "../../src/claude/login/session-login.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import type { ObservedTerminal } from "../../src/core/input/abort.ts";
import { claudeLoginSuccess } from "../fixtures/claude-login.ts";
import { claudePicker } from "../helpers/model-pickers.ts";
import { synchronousRender } from "../helpers/synchronous-render.ts";

afterEach(() => vi.useRealTimers());

test("C-API-43 only the complete native success modal authorizes acknowledgement", () => {
  expect(isClaudeLoginSuccessDialog(claudeLoginSuccess)).toBe(true);
});

const successRows = claudeLoginSuccess
  .split("\n")
  .map((row) => row.trim())
  .filter(Boolean);
const malformedFrames: readonly (readonly [string, string])[] = [
  ...successRows.map(
    (_row, length) => [`${length} painted rows`, successRows.slice(0, length).join("\n")] as const,
  ),
  ...successRows.map(
    (row, index) =>
      [`replaced row ${index + 1}`, claudeLoginSuccess.replace(row, "unrelated")] as const,
  ),
  ["command result", "❯ /login\n  ⎿  Login successful"],
  ["next draft", `${claudeLoginSuccess}\n❯ next draft`],
  ["footer prefix", `${successRows.slice(0, -1).join("\n")}\n  Login suc`],
];
test.each(malformedFrames)("C-API-43 %s does not authorize acknowledgement", (_label, text) => {
  expect(isClaudeLoginSuccessDialog(text)).toBe(false);
});

function confirmationIo() {
  let text = claudeLoginSuccess;
  const terminal = {
    ...synchronousRender,
    snapshot: () => ({ text }),
    sendInput: vi.fn<ObservedTerminal["sendInput"]>(),
  };
  const io: LoginIo = {
    terminal,
    blocked: () => true,
    submit: async () => {},
    awaitUsable: async () => {},
  };
  return {
    io,
    terminal,
    replace: (next: string) => {
      text = next;
    },
  };
}

test("C-API-43 acknowledgement bypasses only its own blocked modal and writes once", async () => {
  const { io, terminal } = confirmationIo();
  await acknowledgeLoginSuccess(io, new AbortController().signal);
  expect(terminal.sendInput).toHaveBeenCalledExactlyOnceWith("\r");
});

test("C-API-43 a modal replaced during received-output observation never receives Enter", async () => {
  const { io, terminal, replace } = confirmationIo();
  terminal.settled = () => {
    replace(claudePicker);
    return Promise.resolve();
  };
  await acknowledgeLoginSuccess(io, new AbortController().signal);
  expect(terminal.sendInput).not.toHaveBeenCalled();
});

test("C-API-43 a withheld acknowledgement retries after the render backlog settles", async () => {
  vi.useFakeTimers();
  const { io, terminal } = confirmationIo();
  let observations = 0;
  terminal.settled = () => (++observations === 1 ? new Promise(() => {}) : Promise.resolve());
  const done = acknowledgeLoginSuccess(io, new AbortController().signal);
  // Cross the 1,000 ms observation budget and the next 100 ms login poll.
  await vi.advanceTimersByTimeAsync(1_101);
  await done;
  expect(terminal.sendInput).toHaveBeenCalledExactlyOnceWith("\r");
});

test.each([
  "aborted",
  "deadline",
])("C-API-43 %s cancels acknowledgement without writing", async (reason) => {
  const { io, terminal } = confirmationIo();
  const controller = new AbortController();
  controller.abort(reason);
  await expect(acknowledgeLoginSuccess(io, controller.signal)).rejects.toMatchObject({
    code: reason === "aborted" ? "session_not_running" : "login_timeout",
  });
  expect(terminal.sendInput).not.toHaveBeenCalled();
});

test.each([
  "complete",
  "partially painted",
  "footer prefix",
])("C-API-43 readiness delivered inside the acknowledgement write completes a %s login", async (paint) => {
  let text = "";
  let ready = () => {};
  let acknowledgedText: string | undefined;
  const writes: string[] = [];
  const terminal = {
    ...synchronousRender,
    snapshot: () => ({ text }),
    sendInput: (input: string | Uint8Array) => {
      const data = String(input);
      writes.push(data);
      if (data === "\r") {
        if (writes.length === 2) {
          text =
            paint === "complete"
              ? claudeLoginSuccess
              : claudeLoginSuccess.split("\n").slice(0, -1).join("\n") +
                (paint === "footer prefix" ? "\n  Login suc" : "");
          if (paint !== "complete")
            setTimeout(() => {
              text = claudeLoginSuccess;
            }, 10);
        } else {
          acknowledgedText = text;
          ready(); // Synchronous native clearance, before the write fulfills.
        }
      }
      return Promise.resolve();
    },
  };
  const queue = new ControlQueue(
    async () => {},
    () => new Error("closed"),
    () => {},
  );
  queue.markReady();
  try {
    await runSessionLogin(
      {
        controlQueue: queue,
        terminal,
        blocked: () => false,
        onReady: (handler) => {
          ready = handler;
          return () => {};
        },
      },
      {
        provideCode: () => {
          throw new Error("unexpected code prompt");
        },
        timeoutMs: 1_000,
      },
    );
    expect(writes).toEqual(["/login", "\r", "\r"]);
    expect(acknowledgedText).toBe(claudeLoginSuccess);
  } finally {
    queue.close();
  }
});
