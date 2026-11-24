/** Isolate and report failing native prompt activity consumers (PRD §5.7). */
import { expect, test } from "vitest";
import { createTranscriptWatcher } from "../../src/claude/session/transcript.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";
import { emitSessionWarningsWithRejectionHandling } from "../../src/core/warnings/session.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { assistant, nativeUser, tmpFile, writeRecords } from "./claude-transcript-helpers.ts";

test.each([
  "throw",
  "reject",
])("final drain contains %s and warning listener rejection", async (behavior) => {
  const path = tmpFile();
  const eventOrder: string[] = [];
  const emitter = new TypedEmitter<{
    activity: ElwoodActivityEvent;
    warning: ElwoodWarningEvent;
  }>();
  emitter.on("activity", (event) => {
    eventOrder.push(event.kind);
    if (event.kind === "user_message" && behavior === "throw") throw new Error("subscriber error");
    if (event.kind === "user_message" || event.kind === "warning")
      return Promise.reject(new Error("subscriber rejection"));
    return undefined;
  });
  emitter.on("warning", () => Promise.reject(new Error("warning rejection")));
  const { watcher, finishSafely } = createTranscriptWatcher("s", emitter, () => ({
    emitWarnings: (warnings) => emitSessionWarningsWithRejectionHandling(warnings, emitter),
  }));
  writeRecords(path);
  watcher.observe(path);
  watcher.observeUserPrompt(path, "first", false);
  writeRecords(path, nativeUser("first", "native text"), assistant("final reply"));
  finishSafely(() => eventOrder.push("exit"));
  await expect
    .poll(() => eventOrder)
    .toEqual(
      behavior === "throw"
        ? ["user_message", "assistant_message", "warning", "exit"]
        : ["user_message", "assistant_message", "exit"],
    );
});

test.each([
  "throw",
  "reject",
])("a recovered prompt observer cannot stop further delivery (%s)", async (failure) => {
  const path = tmpFile();
  const events: ElwoodActivityEvent[] = [];
  const warnings: ElwoodWarningEvent[] = [];
  const emitter = new TypedEmitter<{ activity: ElwoodActivityEvent }>();
  emitter.on("activity", (event) => {
    if (event.kind !== "user_message") return undefined;
    const error = new Error("observer failed");
    if (failure === "throw") throw error;
    return Promise.reject(error);
  });
  emitter.on("activity", (event) => events.push(event));
  const { watcher, finishSafely } = createTranscriptWatcher(
    "session",
    emitter,
    () => ({ emitWarnings: (batch) => warnings.push(...batch) }),
    5,
  );
  writeRecords(path);
  try {
    watcher.observe(path);
    watcher.observeUserPrompt(path, "first", false);
    watcher.observeUserPrompt(path, "next", false);
    writeRecords(
      path,
      nativeUser("first", "committed text"),
      {
        ...assistant("reply"),
        parentUuid: "first",
      },
      nativeUser("next", "next text"),
    );
    await expect
      .poll(() => events)
      .toMatchObject([
        { kind: "user_message", turnId: "first", text: "committed text" },
        { kind: "assistant_message", turnId: "first", text: "reply" },
        { kind: "user_message", turnId: "next", text: "next text" },
      ]);
    await expect
      .poll(() => warnings)
      .toMatchObject([{ code: "transcript_listener_error", agent: "claude", channel: "activity" }]);
  } finally {
    finishSafely();
  }
});
