/** Compile-time witnesses preserve PRD §4 candidate native identity pairing. */
import { expectTypeOf, test } from "vitest";
import type { Candidate } from "../../../src/codex/questions/candidate.ts";
import type { CandidateStore } from "../../../src/codex/questions/candidate-store.ts";

test("narrows native question identities by candidate mode", () => {
  type Modal = Extract<Candidate, { readonly queued: false }>;
  type Queued = Extract<Candidate, { readonly queued: true }>;
  type Fields = Omit<Candidate, "queued" | "questions">;
  expectTypeOf<Modal["accepted"]>().toEqualTypeOf<false>();
  expectTypeOf<
    ReturnType<CandidateStore["availableAcceptedQueuedCandidates"]>[number]["accepted"]
  >().toEqualTypeOf<true>();
  expectTypeOf<CandidateStore["candidates"]>().toEqualTypeOf<ReadonlyMap<string, Candidate>>();
  expectTypeOf<Pick<Candidate, "published">>().toEqualTypeOf<{ readonly published: boolean }>();
  expectTypeOf<Modal["questions"][number]["nativeId"]>().toEqualTypeOf<string>();
  expectTypeOf<Queued["questions"][number]["questionIndex"]>().toEqualTypeOf<number>();
  expectTypeOf<
    Fields & { readonly queued: false; readonly questions: Queued["questions"] }
  >().not.toExtend<Candidate>();
  expectTypeOf<
    Fields & { readonly queued: true; readonly questions: Modal["questions"] }
  >().not.toExtend<Candidate>();
});
