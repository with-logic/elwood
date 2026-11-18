/** Typed acknowledgement failures and owned cleanup (PRD §5.3, C-API-43). */
import { expect, test, vi } from "vitest";
import { acknowledgeLoginSuccess } from "../../src/claude/login/confirmation.ts";
import { runSessionLogin } from "../../src/claude/login/session-login.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { elwoodError } from "../../src/core/errors.ts";
import type { ObservedTerminal } from "../../src/core/input/abort.ts";
import { claudeLoginSuccess } from "../fixtures/claude-login.ts";
import { claudePicker } from "../helpers/model-pickers.ts";
import { synchronousRender } from "../helpers/synchronous-render.ts";

test.each([
  new Error("write fault"),
  "write fault",
])("C-API-43 acknowledgement write rejection becomes login_failed: %s", async (failure) => {
  const terminal = {
    ...synchronousRender,
    snapshot: () => ({ text: claudeLoginSuccess }),
    sendInput: vi.fn<ObservedTerminal["sendInput"]>().mockRejectedValue(failure),
  };
  await expect(
    acknowledgeLoginSuccess({ terminal }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "login_failed", details: { cause: "write fault" } });
});

test("C-API-43 a confirmed close during the acknowledgement write retains session_not_running", async () => {
  const closed = new AbortController();
  const terminal = {
    ...synchronousRender,
    snapshot: () => ({ text: claudeLoginSuccess }),
    sendInput: () => {
      closed.abort("aborted");
      throw new Error("closed PTY");
    },
  };
  await expect(acknowledgeLoginSuccess({ terminal }, closed.signal)).rejects.toMatchObject({
    code: "session_not_running",
  });
});

function loginAttempt(
  afterAcknowledgement: (terminal: ObservedTerminal, queue: ControlQueue) => void,
) {
  let text = "";
  let enters = 0;
  const writes: string[] = [];
  const queue = new ControlQueue(
    async () => {},
    () => elwoodError("session_not_running", "closed"),
    () => {},
  );
  queue.markReady();
  const terminal: ObservedTerminal = {
    ...synchronousRender,
    snapshot: () => ({ text }),
    sendInput: (input) => {
      const data = String(input);
      writes.push(data);
      if (data === "\r") {
        enters += 1;
        if (enters === 1) text = claudeLoginSuccess;
        else afterAcknowledgement(terminal, queue);
      }
    },
  };
  const done = runSessionLogin(
    {
      controlQueue: queue,
      terminal,
      blocked: () => text === claudePicker,
      onReady: () => () => {},
    },
    { provideCode: () => "unused", timeoutMs: 250 },
  );
  return {
    done,
    writes,
    queue,
    replace: (next: string) => {
      text = next;
    },
  };
}

test.each([
  ["a foreign blocking dialog", claudePicker],
  ["a caller draft", "❯ caller draft"],
])("C-API-43 timeout leaves %s untouched", async (_label, text) => {
  const attempt = loginAttempt(() => attempt.replace(text));
  try {
    await expect(attempt.done).rejects.toMatchObject({ code: "login_timeout" });
    expect(attempt.writes).toEqual(["/login", "\r", "\r"]);
  } finally {
    attempt.queue.close();
  }
});

test.each([
  "unobserved",
  "failed",
  "closed during observation",
])("C-API-43 cleanup withholds Escape when output is %s", async (condition) => {
  const attempt = loginAttempt((terminal, queue) => {
    if (condition === "unobserved") terminal.settled = () => new Promise(() => {});
    else if (condition === "failed")
      Object.defineProperty(terminal, "renderFailed", { value: true });
    else
      terminal.settled = () => {
        queue.close();
        return Promise.resolve();
      };
  });
  try {
    await expect(attempt.done).rejects.toMatchObject({
      code: condition === "closed during observation" ? "session_not_running" : "login_timeout",
    });
    expect(attempt.writes).not.toContain("\u001b");
  } finally {
    attempt.queue.close();
  }
});

test("C-API-43 session closure before cleanup sends no Escape", async () => {
  const attempt = loginAttempt((_terminal, queue) => queue.close());
  await expect(attempt.done).rejects.toMatchObject({ code: "session_not_running" });
  expect(attempt.writes).not.toContain("\u001b");
});

test("C-API-43 a failed cleanup write preserves the original timeout", async () => {
  const attempt = loginAttempt((terminal) => {
    terminal.sendInput = () => {
      throw new Error("cleanup write failed");
    };
  });
  try {
    await expect(attempt.done).rejects.toMatchObject({ code: "login_timeout" });
  } finally {
    attempt.queue.close();
  }
});
