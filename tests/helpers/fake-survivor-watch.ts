/** Inert watch for termination orchestration tests with injected signal/reap outcomes (C-LIFE-10). */
import type { SurvivorWatch } from "../../src/runtime/shutdown/detached-sweep/survivor-watch.ts";

export function fakeSurvivorWatch(): SurvivorWatch {
  return {
    firstRead: Promise.resolve(),
    firstObservation: Promise.resolve({ kind: "observed", identity: "fake leader" }),
    sendSignal: (send) => {
      send();
      return Promise.resolve("signal-sent");
    },
    reap: () => Promise.resolve(),
    finish: () => Promise.resolve(),
  };
}
