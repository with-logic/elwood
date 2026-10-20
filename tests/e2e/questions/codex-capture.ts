/** Bounded real queued/modal Codex question round trips (PRD §12). */
import { record } from "../../../src/core/activity/meta.ts";
import {
  type NativeCodexCapture,
  nativeCodexFunctionOutput,
  nativeCodexPayload,
  nativeCodexQuestionObserver,
} from "./codex-observer.ts";
import { nativeCodexQuestionSandbox } from "./codex-sandbox.ts";

const asyncPrompt =
  'Native question lifecycle characterization only. Do not inspect files or run tools except request_user_input_async. Immediately invoke request_user_input_async once with exactly two questions: title "ELWOOD_ASYNC_COLOR: Which color?", options ["Amber", "Blue"]; title "ELWOOD_ASYNC_NOTE: What note?", no options. After raising them, continue carefully reasoning silently about the first 150 prime numbers and do not send your final answer until I answer both questions. Then report the exact color and note received. Do not ask prose questions.';
const modalPrompt =
  'Native question lifecycle characterization only. Do not inspect files or run tools except request_user_input. Invoke request_user_input once with exactly two questions: id "color", header "Color", question "ELWOOD_MODAL_COLOR: Which color?", options Amber(description Warm) and Blue(description Cool); id "note", header "Note", question "ELWOOD_MODAL_NOTE: What note?", options [{label:"Standard",description:"Default note"},{label:"Short",description:"Brief note"}], isSecret false. This must have nonempty options for both questions; the native client adds Other. These synthetic preferences cannot be learned from files. Wait for answers then report the exact answers. Do not call any other tool or ask prose questions.';

function replies(capture: NativeCodexCapture): readonly unknown[] {
  return capture.records.flatMap((item) => {
    const payload = nativeCodexPayload(item);
    if (payload["type"] !== "message" || payload["role"] !== "user") return [];
    const content = payload["content"];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part: unknown) => {
      const text = record(part)["text"];
      if (typeof text !== "string") return [];
      const match = text.match(
        /^<send_user_message_question_reply>\n(.*)\n<\/send_user_message_question_reply>$/s,
      );
      return match?.[1] === undefined ? [] : JSON.parse(match[1]);
    });
  });
}

export async function captureNativeCodexAsyncQuestions(): Promise<NativeCodexCapture> {
  const sandbox = await nativeCodexQuestionSandbox();
  const observer = nativeCodexQuestionObserver(sandbox);
  try {
    await observer.ready();
    await observer.prompt(asyncPrompt);
    await observer.waitForScreen((text) => /\?\s+2 questions/.test(text));
    await observer.capture("badge");
    await observer.write("\x1b[1;2D");
    await observer.waitForScreen(
      (text) => text.includes("1 of 2") && /^\s*› 1\. Amber/m.test(text),
    );
    await observer.capture("editor-first");
    await observer.write("\x1b[B");
    await observer.waitForScreen((text) => /^\s*› 2\. Blue/m.test(text));
    await observer.write("\r");
    await observer.waitForScreen(
      (text) => text.includes("Type your answer") && text.includes("enter submit"),
    );
    await observer.capture("after-first");
    await observer.write("\x1b[200~ELWOOD_NOTE_74\x1b[201~");
    await observer.capture("editor-note");
    await observer.write("\r");
    await observer.waitFor(() =>
      observer.records().some((item) => nativeCodexPayload(item)["type"] === "task_complete"),
    );
    await observer.capture("completed");
    const capture = observer.result();
    if (
      nativeCodexFunctionOutput(capture.records, "request_user_input_async") !== '{"accepted":true}'
    )
      throw new Error("Native asynchronous question tool was not accepted");
    const answers = replies(capture).map(record);
    if (
      answers.length !== 2 ||
      answers[0]?.["question"] !== "ELWOOD_ASYNC_COLOR: Which color?" ||
      answers[0]?.["answer"] !== "Blue" ||
      answers[1]?.["question"] !== "ELWOOD_ASYNC_NOTE: What note?" ||
      answers[1]?.["answer"] !== "ELWOOD_NOTE_74"
    )
      throw new Error("Native asynchronous answer envelopes did not match");
    const call = capture.records
      .map(nativeCodexPayload)
      .find((item) => item["name"] === "request_user_input_async");
    if (
      !answers.every(
        (item, index) =>
          item["questionItemId"] ===
          JSON.stringify(["request_user_input_async", call?.["call_id"], index]),
      )
    )
      throw new Error("Native asynchronous answer targeted a different question");
    return capture;
  } finally {
    await sandbox.dispose();
  }
}

export async function captureNativeCodexModalQuestions(): Promise<NativeCodexCapture> {
  const sandbox = await nativeCodexQuestionSandbox();
  const observer = nativeCodexQuestionObserver(sandbox);
  try {
    await observer.ready();
    await observer.write("/plan");
    await observer.write("\r");
    await observer.waitForScreen((text) => text.includes("Plan mode ("));
    await observer.prompt(modalPrompt);
    await observer.waitForScreen(
      (text) => text.includes("Question 1/2") && text.includes("enter to submit answer"),
    );
    await observer.capture("first");
    await observer.write("\x1b[B");
    await observer.waitForScreen((text) => /^\s*› 2\. Blue/m.test(text));
    await observer.write("\r");
    await observer.waitForScreen((text) => text.includes("Question 2/2 (1 unanswered)"));
    await observer.capture("second");
    await observer.write("\x1b[B");
    await observer.write("\x1b[B");
    await observer.waitForScreen((text) => /^\s*› 3\. None of the above/m.test(text));
    await observer.write("\t");
    await observer.waitForScreen((text) => text.includes("tab or esc to clear notes"));
    await observer.write("\x1b[200~ELWOOD_MODAL_NOTE_85\x1b[201~");
    await observer.capture("note");
    await observer.write("\r");
    await observer.waitFor(() =>
      observer.records().some((item) => nativeCodexPayload(item)["type"] === "task_complete"),
    );
    await observer.capture("completed");
    const capture = observer.result();
    const output = nativeCodexFunctionOutput(capture.records, "request_user_input");
    if (output === undefined) throw new Error("No native modal question result arrived");
    const answers = record(record(JSON.parse(output))["answers"]);
    if (
      JSON.stringify(record(answers["color"])["answers"]) !== '["Blue"]' ||
      JSON.stringify(record(answers["note"])["answers"]) !==
        '["None of the above","user_note: ELWOOD_MODAL_NOTE_85"]'
    )
      throw new Error("Native modal answer result did not match");
    return capture;
  } finally {
    await sandbox.dispose();
  }
}
