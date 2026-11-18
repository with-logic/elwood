/** Native login acknowledgement safety and readiness ordering (PRD §5.3, C-API-43). */
import { afterEach, expect, test, vi } from "vitest";
import {
  acknowledgeLoginSuccess,
  isClaudeLoginSuccessDialog,
} from "../../src/claude/login/confirmation.ts";
import type { LoginIo } from "../../src/claude/login/driver.ts";
import { runSessionLogin } from "../../src/claude/login/session-login.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { claudeLoginSuccess } from "../fixtures/claude-login.ts";
import { claudePicker } from "../helpers/model-pickers.ts";
import { synchronousRender } from "../helpers/synchronous-render.ts";

afterEach(() => vi.useRealTimers());

test("C-API-43 only the complete native success modal authorizes acknowledgement", () => {
  expect(isClaudeLoginSuccessDialog(claudeLoginSuccess)).toBe(true);
  const rows = claudeLoginSuccess
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);
  for (let length = 0; length < rows.length; length += 1)
    expect(isClaudeLoginSuccessDialog(rows.slice(0, length).join("\n"))).toBe(false);
  for (const row of rows)
    expect(isClaudeLoginSuccessDialog(claudeLoginSuccess.replace(row, "unrelated"))).toBe(false);
  expect(isClaudeLoginSuccessDialog("❯ /login\n  ⎿  Login successful")).toBe(false);
  expect(isClaudeLoginSuccessDialog(`${claudeLoginSuccess}\n❯ next draft`)).toBe(false);
});

function confirmationIo() {
  let text = claudeLoginSuccess;
  const terminal = {
    ...synchronousRender,
    snapshot: () => ({ text }),
    sendInput: vi.fn(),
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
        } else ready(); // Synchronous native clearance, before the write fulfills.
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
  } finally {
    queue.close();
  }
});
