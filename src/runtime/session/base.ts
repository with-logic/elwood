/**
 * The caller-facing control surface shared by both adapter sessions — prompt,
 * message, and guidance submission (with image attachment), raw keys, resize,
 * interrupt/compact, the model picker, and recurring loops — layered over the
 * lifecycle core in `lifecycle.ts`. Implements PRD §5.3, §5.7, §5.9.
 */

import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import { sessionImageBudget } from "../../core/images/queued-budget.ts";
import type { SendOptions } from "../../core/images/types.ts";
import { writeQueuedInput } from "../../core/input/index.ts";
import { submissionControlOptions } from "../../core/input/submission-cancel.ts";
import type { ElwoodLoopRequest, ElwoodLoopSnapshot } from "../../core/loops/types.ts";
import { isPickerIntervention } from "../../core/models/intervention.ts";
import type { ModelPickerSpec } from "../../core/models/picker.ts";
import type { AgentModelOption } from "../../core/models/rows.ts";
import type { TerminalReplayBuffer } from "../../core/terminal-replay.ts";
import type { TerminalSize } from "../../core/types.ts";
import type { PtyProcess } from "../../pty/types.ts";
import type { PersistedLoopDefinition } from "../../state/loop-store.ts";
import type { SessionRuntime } from "../../state/runtime-paths.ts";
import type { SessionRecord } from "../../state/store.ts";
import { currentRenderedFrame } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { CommandSurface } from "./commands.ts";
import {
  type AttachDriver,
  type AttachTask,
  enqueueSubmission,
  type SubmitKind,
} from "./image-attach.ts";
import { SessionLifecycle } from "./lifecycle.ts";
import { PickerInputOwnership } from "./picker-input.ts";
import { applyResize, restoreHeldResize } from "./resize.ts";
import type { SessionStatusEmitter } from "./status-wiring.ts";

type Timeout = { readonly timeoutMs?: number };

export abstract class AgentSessionBase extends SessionLifecycle {
  protected abstract readonly picker: ModelPickerSpec;
  private readonly commands: CommandSurface;

  protected constructor(
    agent: ElwoodAgentKind,
    record: SessionRecord,
    stateDir: string,
    runtime: SessionRuntime,
    pty: PtyProcess,
    terminal: ElwoodTerminal,
    statusEvents: SessionStatusEmitter,
    terminalReplay: TerminalReplayBuffer,
    loopDefinitions: readonly PersistedLoopDefinition[],
  ) {
    const ownership = new PickerInputOwnership(terminal);
    super(
      agent,
      record,
      stateDir,
      runtime,
      pty,
      ownership,
      statusEvents,
      terminalReplay,
      loopDefinitions,
    );
    // `picker` is a subclass field initializer that runs AFTER this constructor, so the
    // surface resolves it per call rather than capturing it here.
    this.commands = new CommandSurface({
      terminal: ownership.automated,
      inputSignal: () => ownership.signal(),
      observeRendered: (listener) => {
        terminal.xterm.onWriteParsed(listener);
      },
      statusEvents,
      status: () => this.status,
      everReady: () => this.everReady,
      blocked: () => super.isInputBlocked(),
      picker: () => this.picker,
      controlQueue: this.controlQueue,
      submitDirect: (command, signal) =>
        writeQueuedInput(
          ownership.automated,
          command,
          "command",
          {
            ...this.pasteGuard,
            blocked: () => isPickerIntervention(signal.reason) || this.queuedInputBlocked(),
          },
          signal,
        ),
    });
  }

  /** Every queued writer also holds on a model dialog that outlived its cleanup (C-API-55). */
  protected override isInputBlocked(): boolean {
    return super.isInputBlocked() || this.commands.blocksInput();
  }

  /**
   * Writes that are NOT part of a picker transaction (`/login` recovery) must additionally
   * stand off a model dialog a human opened. It is deliberately not part of
   * `isInputBlocked`: that feeds readiness, and suppressing readiness while any picker is
   * visible would deadlock Elwood's own picker, whose dialog is on screen by design.
   */
  protected foreignDialogBlocksWrite(): boolean {
    return this.commands.foreignDialogVisible();
  }

  /** Ordinary queued text and attachments cannot drive a model dialog that they did not open. */
  protected queuedInputBlocked(): boolean {
    return this.isInputBlocked() || this.foreignDialogBlocksWrite();
  }

  sendPrompt(prompt: string, options?: SendOptions): Promise<void> {
    return this.enqueue(prompt, "prompt", options);
  }
  sendMessage(message: string, options?: SendOptions): Promise<void> {
    return this.enqueue(message, "message", options);
  }
  sendGuidance(message: string, options?: SendOptions): Promise<void> {
    return this.enqueue(message, "guidance", options);
  }
  sendKeys(input: string | Uint8Array): Promise<void> {
    return this.inSession(async () => {
      await this.terminal.sendInput(input);
      this.loops.callerActivity();
    });
  }
  resize(size: TerminalSize): Promise<void> {
    return this.inSession(() => applyResize(this.pty, this.terminal, size));
  }
  interrupt(options?: Timeout): Promise<void> {
    return this.inSession(() => this.commands.interrupt(options));
  }
  compact(options?: Timeout): Promise<void> {
    return this.inSession(() => this.commands.compact(options));
  }
  listModels(options?: Timeout): Promise<readonly AgentModelOption[]> {
    return this.inSession(() => this.commands.listModels(options));
  }
  setModel(
    id: string,
    options?: Timeout,
    around?: (flow: () => Promise<void>, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    return this.inSession(() => this.commands.setModel(id, options, around));
  }
  createLoop(request: ElwoodLoopRequest): Promise<ElwoodLoopSnapshot> {
    return this.inSession(() => this.loops.create(request));
  }
  listLoops(): Promise<readonly ElwoodLoopSnapshot[]> {
    return this.inSession(() => this.loops.list(), true);
  }
  cancelLoop(loopId: string): Promise<void> {
    return this.inSession(() => this.loops.cancel(loopId), true);
  }

  /** A stable completed frame only when the native composer is positively empty (C-API-56). */
  protected emptyComposerFrame(): object | undefined {
    const frame = currentRenderedFrame(this.terminal);
    return frame && this.picker.isClear(frame.text) ? frame : undefined;
  }
  /** Attach `paths` to the composer before the queued text is submitted (C-API-44). */
  protected abstract attachImages(paths: readonly string[], signal: AbortSignal): Promise<void>;
  /** Re-apply a resize that was held during startup (a best-effort restore). */
  protected restoreHeldSize(size: TerminalSize): void {
    void restoreHeldResize(this.pty, this.terminal, size);
  }

  private enqueue(input: string, kind: SubmitKind, options?: SendOptions): Promise<void> {
    const driver: AttachDriver = (paths, signal) => this.attachImages(paths, signal);
    const send = (attach?: AttachTask) =>
      this.controlQueue.send(input, kind, attach, submissionControlOptions(options));
    // Looked up per call: a facade that launched this session shares ITS budget (C-API-44).
    const budget = sessionImageBudget(this);
    return this.inSession(() => enqueueSubmission(options?.images, driver, send, budget));
  }
}
