/**
 * Regression for the adapter `on` order (PRD §5.3): a session REGISTERS a `terminal:data`
 * listener BEFORE replaying the buffered startup output, so a consumer handler that THROWS during
 * replay is still subscribed for FUTURE data (otherwise terminal telemetry silently disappears).
 * This pins the register-before-replay invariant the adapters' `on` implements.
 */

import { describe, expect, test } from "vitest";
import { TerminalReplayBuffer } from "../../src/core/terminal-replay.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

type Map = { "terminal:data": { readonly elwoodSessionId: string; readonly data: string } };

/** Mirror of the adapters' `on`: register on the emitter FIRST, then replay buffered data. */
function subscribeLikeAdapter(
  emitter: TypedEmitter<Map>,
  replay: TerminalReplayBuffer,
  handler: (e: Map["terminal:data"]) => void,
) {
  const unsubscribe = emitter.on("terminal:data", handler); // register FIRST
  replay.replay(handler); // then replay buffered startup output (may throw)
  return unsubscribe;
}

describe("adapter on() register-before-replay (PRD §5.3)", () => {
  test("a handler that THROWS during replay still receives FUTURE terminal data", () => {
    const emitter = new TypedEmitter<Map>();
    const replay = new TerminalReplayBuffer("s1");
    replay.push("BUFFERED-STARTUP-OUTPUT"); // some data is buffered before the subscription

    const future: string[] = [];
    let replayThrew = false;
    const handler = (e: Map["terminal:data"]) => {
      if (e.data === "BUFFERED-STARTUP-OUTPUT") {
        replayThrew = true;
        throw new Error("consumer replay handler boom");
      }
      future.push(e.data); // FUTURE (post-replay) data
    };

    // The replay throw must NOT prevent registration. Contain it as the adapter's caller would.
    expect(() => subscribeLikeAdapter(emitter, replay, handler)).toThrow(/replay handler boom/);
    expect(replayThrew).toBe(true);

    // Now new data arrives — the handler is still subscribed and receives it (no silent loss).
    emitter.emit("terminal:data", { elwoodSessionId: "s1", data: "LIVE-1" });
    emitter.emit("terminal:data", { elwoodSessionId: "s1", data: "LIVE-2" });
    expect(future).toEqual(["LIVE-1", "LIVE-2"]);
  });

  test("with the OLD order (replay before register) a throwing replay loses future data", () => {
    // Demonstrates the bug the reorder fixes: replaying BEFORE registering means a throw skips
    // registration entirely, so future data never reaches the handler.
    const emitter = new TypedEmitter<Map>();
    const replay = new TerminalReplayBuffer("s1");
    replay.push("BUFFERED");
    const future: string[] = [];
    const handler = (e: Map["terminal:data"]) => {
      if (e.data === "BUFFERED") throw new Error("boom");
      future.push(e.data);
    };
    expect(() => {
      replay.replay(handler); // OLD order: replay first...
      emitter.on("terminal:data", handler); // ...register second (never reached on throw)
    }).toThrow(/boom/);
    emitter.emit("terminal:data", { elwoodSessionId: "s1", data: "LIVE" });
    expect(future).toEqual([]); // lost — the very failure the register-first order prevents
  });
});
