/** Shared adapter session behavior: lifecycle, input, command surface. Implements PRD §5.3, §5.7. */
import { ControlQueue } from "../core/control-queue.ts";
import { toError } from "../core/errors.ts";
import { writeQueuedInput } from "../core/session-input.ts";
import { writeSessionRecord } from "../state/store.ts";
import { CleanupLatch } from "./cleanup-latch.ts";
import { advanceInitialReady } from "./initial-ready-advance.ts";
import * as Base from "./session-base-types.ts";
import { CommandSurface } from "./session-commands.ts";
import { enqueueSubmission, QueuedImageBudget } from "./session-image-attach.ts";
import { SessionLoops } from "./session-loops.ts";
import { SessionReapPolicy } from "./session-reap.ts";
import { applyResize, restoreHeldResize } from "./session-resize.ts";
import { SessionShutdownBinding } from "./session-shutdown-binding.ts";
import { terminalStatuses } from "./session-status.ts";
import { createSessionStatusEngine } from "./session-status-wiring.ts";

export abstract class AgentSessionBase {
  protected record: Base.SessionRecord;
  readonly terminal: Base.ElwoodTerminal;
  protected abstract readonly picker: Base.ModelPickerSpec;
  private readonly agent: Base.ElwoodAgentKind;
  private readonly runtime: Base.SessionRuntime;
  private readonly pty: Base.PtyProcess;
  private readonly reapPolicy: SessionReapPolicy;
  private readonly commands: CommandSurface;
  private readonly terminalReplay: Base.TerminalReplayBuffer;
  private readonly loops: SessionLoops;
  private readonly cleanupLatch = new CleanupLatch(() => this.stopRuntime());
  private readonly shutdown: SessionShutdownBinding;
  private everReady = false;
  private readonly pasteGuard: Base.PasteGuard = {
    snapshot: () => this.terminal.snapshot().text,
    staged: (s, p) => this.stagedPaste(s, p),
    blocked: () => this.status === "blocked",
  };
  protected readonly controlQueue = new ControlQueue(
    (input, mode, signal) => writeQueuedInput(this.terminal, input, mode, this.pasteGuard, signal),
    () => Base.notRunningError(this.agent),
    (origin) => {
      this.loops.turnStarted(origin);
      this.submitEvidence("caller_submitted");
    },
    () => this.status === "running",
  );
  private readonly statusEngine: Base.SessionStatusEngine;
  protected constructor(
    agent: Base.ElwoodAgentKind,
    record: Base.SessionRecord,
    stateDir: string,
    runtime: Base.SessionRuntime,
    pty: Base.PtyProcess,
    terminal: Base.ElwoodTerminal,
    statusEvents: Base.SessionStatusEmitter,
    terminalReplay: Base.TerminalReplayBuffer,
    loopDefinitions: readonly Base.PersistedLoopDefinition[],
  ) {
    this.agent = agent;
    this.record = record;
    this.runtime = runtime;
    this.pty = pty;
    this.reapPolicy = new SessionReapPolicy(agent, record.elwoodSessionId, pty.pid);
    this.terminal = terminal;
    this.terminalReplay = terminalReplay;
    this.loops = new SessionLoops({
      stateDir,
      elwoodSessionId: record.elwoodSessionId,
      definitions: loopDefinitions,
      queue: this.controlQueue,
      emitter: statusEvents,
    });
    this.statusEngine = createSessionStatusEngine({
      agent,
      elwoodSessionId: record.elwoodSessionId,
      emitter: statusEvents,
      queue: this.controlQueue,
      loops: this.loops,
      markReady: () => {
        this.everReady = true;
      },
      cleanup: () => this.cleanupLatch.float(),
    });
    this.commands = new CommandSurface({
      terminal,
      statusEvents,
      status: () => this.status,
      everReady: () => this.everReady,
      picker: () => this.picker,
      submit: (command, kind) => this.controlQueue.send(command, kind),
    });
    this.shutdown = new SessionShutdownBinding({
      pty,
      stateDir,
      runtime,
      reapPolicy: this.reapPolicy,
      loops: this.loops,
      elwoodSessionId: () => this.elwoodSessionId,
      status: () => this.status,
      cleanupRuntime: () => this.cleanupRuntime(),
      submitEvidence: (kind) => void this.submitEvidence(kind),
    });
  }
  get elwoodSessionId(): string {
    return this.record.elwoodSessionId;
  }
  get cwd(): string {
    return this.record.cwd;
  }
  get status(): Base.ElwoodSessionStatus {
    return this.statusEngine.status;
  }
  protected get hasBeenReady(): boolean {
    return this.everReady;
  }
  sendPrompt = (prompt: string, options?: Base.SendOptions) =>
    this.enqueue(prompt, "prompt", options);
  sendMessage = (msg: string, options?: Base.SendOptions) => this.enqueue(msg, "message", options);
  sendGuidance = (msg: string, options?: Base.SendOptions) =>
    this.enqueue(msg, "guidance", options);
  createLoop = (request: Base.ElwoodLoopRequest): Promise<Base.ElwoodLoopSnapshot> =>
    this.inSession(() => this.loops.create(request));
  listLoops = (): Promise<readonly Base.ElwoodLoopSnapshot[]> =>
    this.inSession(() => this.loops.list(), true);
  cancelLoop = (loopId: string): Promise<void> =>
    this.inSession(() => this.loops.cancel(loopId), true);
  protected abstract attachImages(paths: readonly string[], signal: AbortSignal): Promise<void>;
  private readonly imageBudget = new QueuedImageBudget();
  private enqueue(input: string, kind: Base.SubmitKind, options?: Base.SendOptions): Promise<void> {
    const driver: Base.AttachDriver = (paths, signal) => this.attachImages(paths, signal);
    const send = (a?: Base.AttachTask) => this.controlQueue.send(input, kind, a);
    return this.inSession(() => enqueueSubmission(options?.images, driver, send, this.imageBudget));
  }
  sendKeys = (input: string | Uint8Array): Promise<void> =>
    this.inSession(async () => {
      await this.terminal.sendInput(input);
      this.loops.callerActivity();
    });
  resize(size: Base.TerminalSize): Promise<void> {
    return this.inSession(() => applyResize(this.pty, this.terminal, size));
  }
  protected restoreHeldSize = (size: Base.TerminalSize) =>
    void restoreHeldResize(this.pty, this.terminal, size);
  interrupt = (o?: { readonly timeoutMs?: number }) =>
    this.inSession(() => this.commands.interrupt(o));
  compact = (o?: { readonly timeoutMs?: number }) => this.inSession(() => this.commands.compact(o));
  listModels = (o?: { readonly timeoutMs?: number }): Promise<readonly Base.AgentModelOption[]> =>
    this.inSession(() => this.commands.listModels(o));
  setModel(id: string, o?: { readonly timeoutMs?: number }): Promise<void> {
    return this.inSession(() => this.commands.setModel(id, o));
  }
  stop = (): Promise<void> => {
    this.loops.pause();
    return this.shutdown.stop();
  };
  kill = (): Promise<void> => this.shutdown.kill();
  teardown = (): Promise<void> => this.shutdown.teardown();
  submitEvidence = (kind: Base.StatusEvidenceKind): Base.StatusDecision =>
    this.statusEngine.submit(kind);
  submitExit(): Base.StatusDecision {
    try {
      return this.statusEngine.submit(this.shutdown.exitEvidence());
    } finally {
      const warning = this.reapPolicy.bestEffort(); // live `reap_failed` warning, never a throw
      if (warning) this.emitWarnings([warning]);
    }
  }
  statusDecisions = (): readonly Base.StatusDecision[] => this.statusEngine.decisions();
  protected abstract stagedPaste(screen: string, prompt: string): boolean;
  protected abstract stopRuntime(): Promise<void>;
  protected abstract emitWarnings(warnings: readonly Base.ElwoodWarningEvent[]): void;
  protected replayFor(event: string, handler: unknown): void {
    if (event === "terminal:data") this.terminalReplay.replay(handler as never);
  }
  protected inSession<T>(work: () => Promise<T> | T, allowTerminal = false): Promise<T> {
    if (!allowTerminal && terminalStatuses.has(this.status)) {
      return Promise.reject(Base.notRunningError(this.agent));
    }
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(toError(error));
    }
  }
  protected persist(record: Base.SessionRecord): void {
    writeSessionRecord(record, this.runtime.sessionDir); // atomic record write FIRST, commit in-memory on success (§8.2)
    this.record = record;
  }
  protected cleanupRuntime(): Promise<void> {
    return this.cleanupLatch.attempt();
  }
  protected advanceInitialReady(): void {
    advanceInitialReady({
      agent: this.agent,
      elwoodSessionId: this.elwoodSessionId,
      submitInitialReady: () => this.submitEvidence("initial_ready"),
      markReady: () => this.controlQueue.markReady(),
      emitWarnings: (w) => this.emitWarnings(w),
    });
  }
}
