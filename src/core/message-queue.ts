/**
 * Queued adapter-neutral message submission for agent sessions.
 * Implements PRD §5.3 and C-API-19.
 */

export type MessageQueueError = () => Error;
export type MessageSubmitMode = "message" | "command";
export type MessageSubmitter = (message: string, mode: MessageSubmitMode) => void;

type QueuedMessage = {
  readonly message: string;
  readonly mode: MessageSubmitMode;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

export class MessageQueue {
  private readonly queue: QueuedMessage[] = [];
  private readonly submit: MessageSubmitter;
  private readonly stoppedError: MessageQueueError;
  private readonly onSubmitted: () => void;
  private ready = false;
  private closed = false;

  constructor(submit: MessageSubmitter, stoppedError: MessageQueueError, onSubmitted: () => void) {
    this.submit = submit;
    this.stoppedError = stoppedError;
    this.onSubmitted = onSubmitted;
  }

  send(message: string, mode: MessageSubmitMode = "message"): Promise<void> {
    if (this.closed) return Promise.reject(this.stoppedError());
    if (this.ready && this.queue.length === 0) return this.submitNow(message, mode);
    return new Promise((resolve, reject) => {
      this.queue.push({ message, mode, resolve, reject });
      this.drain();
    });
  }

  markReady(): void {
    if (this.closed) return;
    this.ready = true;
    this.drain();
  }

  markRunning(): void {
    this.ready = false;
  }

  close(): void {
    this.closed = true;
    const error = this.stoppedError();
    for (const message of this.queue.splice(0)) message.reject(error);
  }

  private drain(): void {
    if (!(this.ready && this.queue.length > 0)) return;
    const message = this.queue.shift() as QueuedMessage;
    this.submitNow(message.message, message.mode).then(message.resolve, message.reject);
  }

  private submitNow(message: string, mode: MessageSubmitMode): Promise<void> {
    try {
      this.ready = false;
      this.submit(message, mode);
      this.onSubmitted();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
