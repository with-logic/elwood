/**
 * Accumulates one safe response while coordinating human and machine CLI renderers.
 * Implements PRD §12A.3 and C-CLI-10 through C-CLI-12.
 */

import type { TurnEvent } from "../../core/simple/events.ts";
import type { ElwoodWarningEvent } from "../../core/types.ts";
import { writeJson } from "../output/json.ts";
import { JsonlRenderer } from "../output/jsonl.ts";
import { progressFromTurn, progressFromWarning } from "../output/records.ts";
import { createCliSanitizer, formatDiagnosticValue } from "../output/sanitize.ts";
import { StreamingTextRenderer, writeFinalText } from "../output/text.ts";
import type { CliProgressRecord, CliTerminalRecord, CliTextSanitizer } from "../output/types.ts";
import type { AsyncOutputSink } from "../stream.ts";
import { agentDisplayName, type EffectiveRunRequest } from "../types.ts";
import { completionLine, conciseLine, debugLine } from "./output-lines.ts";

export type RunOutputHooks = {
  readonly consumerClosed: () => void;
  readonly failed: (error: unknown) => void;
};

export class RunOutput {
  private readonly request: EffectiveRunRequest;
  private readonly stdout: AsyncOutputSink;
  private readonly stderr: AsyncOutputSink;
  private readonly hooks: RunOutputHooks;
  private readonly elapsedMs: () => number;
  private clean: CliTextSanitizer = createCliSanitizer();
  private readonly responseParts: string[] = [];
  private readonly jsonl: JsonlRenderer;
  private readonly streamed: StreamingTextRenderer;
  private tail: Promise<void> = Promise.resolve();
  private ended = false;

  constructor(
    request: EffectiveRunRequest,
    stdout: AsyncOutputSink,
    stderr: AsyncOutputSink,
    hooks: RunOutputHooks,
    elapsedMs: () => number,
  ) {
    this.request = request;
    this.stdout = stdout;
    this.stderr = stderr;
    this.hooks = hooks;
    this.elapsedMs = elapsedMs;
    this.jsonl = new JsonlRenderer(stdout, elapsedMs);
    this.streamed = new StreamingTextRenderer(stdout);
  }

  setSecrets(secrets: readonly string[]): void {
    this.clean = createCliSanitizer(secrets);
  }

  get response(): string {
    return this.responseParts.join("\n\n");
  }

  sanitize(value: string): string {
    return this.clean(value);
  }

  turn(event: TurnEvent): Promise<void> {
    const record = progressFromTurn(event, this.clean);
    if (record.type === "text" && !(this.request.output === "text" && this.request.stream)) {
      this.responseParts.push(record.text);
    }
    return this.enqueue(record);
  }

  status(status: CliProgressRecord & { readonly type: "status" }): void {
    void this.enqueue(status);
  }

  warning(event: ElwoodWarningEvent): void {
    if (this.ended) return;
    if (this.request.output !== "jsonl" && !this.request.verbose && this.request.debug !== true)
      return;
    void this.enqueue(progressFromWarning(event, this.clean));
  }

  starting(): void {
    this.progress(
      `Starting ${agentDisplayName(this.request.agent)} in ${this.diagnosticValue(this.request.cwd)}`,
    );
  }

  runningPrompt(): void {
    this.progress("Running prompt");
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  async finish(terminalRecord: () => CliTerminalRecord): Promise<void> {
    this.ended = true;
    await this.flush();
    let record = terminalRecord();
    if (this.request.verbose || this.request.debug === true) {
      const line = this.timed(completionLine(record, this.diagnosticValue));
      // A failed completion write is now the primary failure; the record must say so.
      if (!(await this.observeDiagnostic(line))) record = terminalRecord();
    }
    if (this.request.output === "json") await this.observeWrite(writeJson(this.stdout, record));
    else if (this.request.output === "jsonl") await this.observeWrite(this.jsonl.finish(record));
    else if (this.request.stream) await this.observeWrite(this.streamed.finish());
    else await this.observeWrite(writeFinalText(this.stdout, record.response));
    if (this.request.output === "text" && record.type === "error" && !this.stderr.closed) {
      await this.observeDiagnostic(`elwood: ${this.diagnosticValue(record.error.message)}\n`);
    }
    if (
      this.request.output === "text" &&
      this.request.keep &&
      record.sessionId !== null &&
      record.cleanup.status === "succeeded"
    ) {
      await this.observeDiagnostic(`elwood: session ${this.diagnosticValue(record.sessionId)}\n`);
    }
  }

  private enqueue(record: CliProgressRecord): Promise<void> {
    if (this.ended) return Promise.resolve();
    const pending = this.tail.then(async () => {
      if (this.request.output === "jsonl") await this.observeWrite(this.jsonl.progress(record));
      if (this.request.stream && record.type === "text")
        await this.observeWrite(this.streamed.message(record.text));
      const jsonlWarning = this.request.output === "jsonl" && record.type === "warning";
      if (!jsonlWarning && this.request.debug === true)
        await this.stderr.write(this.timed(debugLine(record, this.diagnosticValue)));
      else if (!jsonlWarning && this.request.verbose) {
        const line = conciseLine(record, this.diagnosticValue);
        if (line !== undefined) await this.stderr.write(this.timed(line));
      }
    });
    this.tail = pending.catch((error) => this.hooks.failed(error));
    return this.tail;
  }

  private async observeWrite(write: Promise<boolean>): Promise<void> {
    if (!(await write)) this.hooks.consumerClosed();
  }

  private progress(message: string): void {
    if (!this.request.verbose && this.request.debug !== true) return;
    this.queueDiagnostic(this.timed(`${message}\n`));
  }

  private queueDiagnostic(line: string): void {
    const pending = this.tail.then(async () => {
      await this.stderr.write(line);
    });
    this.tail = pending.catch((error) => this.hooks.failed(error));
  }

  private timed(line: string): string {
    return `[${(Math.max(0, Math.trunc(this.elapsedMs())) / 1_000).toFixed(1)}s] ${line}`;
  }

  /** False when the diagnostic write failed outright (a closed stderr is not a failure). */
  private async observeDiagnostic(line: string): Promise<boolean> {
    try {
      await this.stderr.write(line);
      return true;
    } catch (error) {
      this.hooks.failed(error);
      return false;
    }
  }

  private readonly diagnosticValue = (value: string): string =>
    formatDiagnosticValue(value, this.clean);
}
