/** Unsupported native secret metadata never grants input authority (PRD §4). */
import { expect, test } from "vitest";
import { jsonRecord, payloadOf } from "../../../src/codex/questions/records.ts";
import { record } from "../../../src/core/activity/meta.ts";
import { harness } from "./adapter-helpers.ts";
import { captured, records } from "./helpers.ts";

const variants = ["modal-call", "queued-call", "queued-mirror"] as const;
function questionHarnessWithSecretMetadata(
  variant: (typeof variants)[number],
  flag: unknown,
  present = true,
) {
  const native = records(variant === "modal-call" ? "blocking-records.json" : "async-records.json");
  const payload = payloadOf(native[variant === "queued-mirror" ? 1 : 0])!;
  const args =
    variant === "queued-mirror" ? record(payload["item"]) : jsonRecord(payload["arguments"])!;
  const questions = args["questions"];
  if (!Array.isArray(questions)) throw new Error("Expected captured question definitions");
  const changed = questions.map((question, index) => {
    const value = { ...record(question) };
    delete value["isSecret"];
    return index === questions.length - 1 && present ? { ...value, isSecret: flag } : value;
  });
  const observed =
    variant === "queued-mirror"
      ? { ...payload, item: { ...args, questions: changed } }
      : { ...payload, arguments: JSON.stringify({ ...args, questions: changed }) };
  const h = harness();
  h.observe({ payload: observed });
  if (variant === "queued-call") h.observe(native[2]);
  h.adapter.render(
    captured(variant === "modal-call" ? "blocking-modal-first.txt" : "async-badge.txt"),
  );
  return h;
}
for (const variant of variants) {
  test.each(
    [true, "true", "false", 1, 0, null, [], {}].map((flag) => ({ flag })),
  )(`rejects complete ${variant} when a nested isSecret flag is unsupported: $flag`, ({ flag }) => {
    const h = questionHarnessWithSecretMetadata(variant, flag);
    expect(h.registry.list()).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.adapter.blocksInput()).toBe(true);
  });
  test.each([
    "absent",
    "false",
  ])(`publishes supported ${variant} metadata when isSecret is %s`, (kind) => {
    const h = questionHarnessWithSecretMetadata(variant, false, kind === "false");
    expect(h.registry.list()).toHaveLength(variant === "modal-call" ? 1 : 2);
    expect(
      h.registry
        .list()
        .every((request) => request.questions.every((question) => question.secret === false)),
    ).toBe(true);
  });
}
