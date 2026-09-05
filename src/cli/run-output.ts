/**
 * Accumulates one safe response while coordinating human and machine CLI renderers.
 * Implements PRD §12A.3 and C-CLI-10 through C-CLI-12.
 */

import type { TurnEvent } from "../core/simple/events.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { writeJson } from "./output/json.ts";
import { JsonlRenderer } from "./output/jsonl.ts";
import { progressFromTurn, progressFromWarning } from "./output/records.ts";
import { createCliSanitizer } from "./output/sanitize.ts";
import { StreamingTextRenderer, writeFinalText } from "./output/text.ts";
import type { CliProgressRecord, CliTerminalRecord, CliTextSanitizer } from "./output/types.ts";
import type { AsyncOutputSink } from "./stream.ts";
import type { EffectiveRunRequest } from "./types.ts";

export type RunOutputHooks = {
  readonly consumerClosed: () => void;
  readonly failed: (error: unknown) => void;
};

export class RunOutput {
  private readonly request: EffectiveRunRequest;
  private readonly stdout: AsyncOutputSink;
  private readonly stderr: AsyncOutputSink;
  private readonly hooks: RunOutputHooks;
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
  ) {
    this.request = request;
    this.stdout = stdout;
    this.stderr = stderr;
    this.hooks = hooks;
    this.jsonl = new JsonlRenderer(stdout);
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
    void this.enqueue(progressFromWarning(event, this.clean));
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  async finish(record: CliTerminalRecord): Promise<void> {
    this.ended = true;
    await this.flush();
    if (this.request.output === "json") await this.observeWrite(writeJson(this.stdout, record));
    else if (this.request.output === "jsonl") await this.observeWrite(this.jsonl.finish(record));
    else if (this.request.stream) await this.observeWrite(this.streamed.finish());
    else await this.observeWrite(writeFinalText(this.stdout, record.response));
    if (this.request.output === "text" && record.type === "error" && !this.stdout.closed) {
      await this.stderr.write(`elwood: ${record.error.code}: ${record.error.message}\n`);
    }
    if (
      this.request.output === "text" &&
      this.request.keep &&
      record.sessionId !== null &&
      record.cleanup.status === "succeeded"
    ) {
      await this.stderr.write(`elwood: session ${record.sessionId}\n`);
    }
  }

  private enqueue(record: CliProgressRecord): Promise<void> {
    if (this.ended) return Promise.resolve();
    const pending = this.tail.then(async () => {
      if (this.request.output === "jsonl") await this.observeWrite(this.jsonl.progress(record));
      if (this.request.stream && record.type === "text")
        await this.observeWrite(this.streamed.message(record.text));
      if (this.request.verbose) await this.stderr.write(verboseLine(record));
    });
    this.tail = pending.catch((error) => this.hooks.failed(error));
    return this.tail;
  }

  private async observeWrite(write: Promise<boolean>): Promise<void> {
    if (!(await write)) this.hooks.consumerClosed();
  }
}

function verboseLine(record: CliProgressRecord): string {
  switch (record.type) {
    case "text":
      return `[assistant] ${record.text}\n`;
    case "thinking":
      return `[thinking] ${record.text}\n`;
    case "tool":
      return `[tool ${record.phase}] ${record.name ?? "unknown"}${record.content === undefined ? "" : ` ${record.content}`}\n`;
    case "status":
      return `[status] ${record.status}\n`;
    case "warning":
      return `[warning ${record.code}] ${record.message}\n`;
  }
}
