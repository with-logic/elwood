/**
 * One session's input ownership: caller keys reach the terminal through `caller`, and
 * Elwood's operations write through `automated`. Startup responders write through their
 * own guarded writers, whose sends run inside `withAutomatedInput`, the same scope.
 * Raw caller input aborts `signal()`, which revokes the automation holding the terminal at
 * that moment: picker operations (C-API-55), composer cleanup, and native question answers.
 * Listeners registered with `onCallerInput` hear of it too, which hands the session's
 * startup prompts to the caller (C-TRUST-01, C-CODEX-12).
 */
import type { EmptyComposerObserver } from "../../core/input/clear-ack.ts";
import { ComposerCleanup } from "../../core/input/composer-cleanup.ts";
import { callerInputIntervention } from "../../core/models/intervention.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";

type AutomatedWork = () => Promise<void>;
const automationScopes = new WeakMap<
  ElwoodTerminal["xterm"],
  (work: AutomatedWork) => Promise<void>
>();

/** Keyed by the session's xterm, which every terminal view of that session shares. */
const callerInputListeners = new WeakMap<object, Set<() => void>>();

/**
 * Run `listener` whenever caller input revokes automation in this terminal's session,
 * until the returned function unsubscribes it.
 */
export function onCallerInput(
  terminal: { readonly xterm: object },
  listener: () => void,
): () => void {
  const listeners = callerInputListeners.get(terminal.xterm);
  listeners?.add(listener);
  return () => {
    listeners?.delete(listener);
  };
}

/** Preserve the same ownership scope for startup writers that retain their own input policy. */
export function withAutomatedInput(terminal: ElwoodTerminal, work: AutomatedWork): Promise<void> {
  return automationScopes.get(terminal.xterm)?.(work) ?? work();
}

export class SessionInputOwnership {
  readonly caller: ElwoodTerminal;
  readonly automated: ElwoodTerminal;
  private current = new AbortController();

  constructor(inner: ElwoodTerminal) {
    let automating = false;
    const listeners = new Set<() => void>();
    callerInputListeners.set(inner.xterm, listeners);
    // Runs before the caller's keys are written: picker operations and the startup
    // answers registered through onCallerInput stop, so none of their writes follow them.
    const revoke = () => {
      this.current.abort(callerInputIntervention());
      this.current = new AbortController();
      for (const listener of listeners) listener();
    };
    // onData also carries parser-generated protocol replies; only input invocations
    // represent caller keys. Native startup queries must not revoke draft ownership.
    const input = inner.xterm.input.bind(inner.xterm);
    inner.xterm.input = (data, wasUserInput) => {
      // Each write consumes the automation marker while xterm runs it, so input that an
      // `onData` listener sends from inside an automated write is the caller's and revokes.
      const automated = automating;
      automating = false;
      try {
        if (!automated) revoke();
        input(data, wasUserInput);
      } finally {
        automating = automated;
      }
    };
    const automate = (work: AutomatedWork) => {
      const prior = automating;
      automating = true;
      try {
        return work();
      } finally {
        automating = prior;
      }
    };
    automationScopes.set(inner.xterm, automate);
    const send = (input: string | Uint8Array) => automate(() => inner.sendInput(input));
    this.automated = view(inner, send);
    this.caller = view(inner, (input) => {
      revoke();
      return send(input);
    });
  }

  composerCleanup(
    blocked: () => boolean,
    closing: AbortSignal,
    observeEmpty: EmptyComposerObserver,
  ): ComposerCleanup["run"] {
    const cleanup = new ComposerCleanup(
      this.automated,
      blocked,
      closing,
      () => this.signal(),
      observeEmpty,
    );
    return (work, signal) => cleanup.run(work, signal);
  }

  signal(): AbortSignal {
    return this.current.signal;
  }
}

function view(inner: ElwoodTerminal, sendInput: ElwoodTerminal["sendInput"]): ElwoodTerminal {
  return {
    get xterm() {
      return inner.xterm;
    },
    get size() {
      return inner.size;
    },
    get title() {
      return inner.title;
    },
    get renderFailed() {
      return inner.renderFailed;
    },
    writeOutput: (...args) => inner.writeOutput(...args),
    sendInput,
    resize: (size) => inner.resize(size),
    snapshot: () => inner.snapshot(),
    settled: () => inner.settled(),
    dispose: () => inner.dispose(),
  };
}
