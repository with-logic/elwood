/** Shared asset tasks retain live consumer/error ownership (PRD §13; docs/design/landing.md). */
export class SpriteLoads {
  constructor(bank, onError) {
    this.bank = bank;
    this.onError = onError;
    this.tasks = new Map();
    this.automatic = new Map();
    this.failed = new Set();
  }
  retry(name) {
    for (const key of this.failed)
      if (key === name || key.startsWith(`${name}/`)) this.failed.delete(key);
  }
  request(key, load) {
    if (this.bank.disposed || this.automatic.has(key) || this.failed.has(key)) return;
    const token = {};
    this.automatic.set(key, token);
    load({ automatic: true }).catch(() => {}).finally(() => {
      if (this.automatic.get(key) === token) this.automatic.delete(key);
    });
  }
  run(key, pending, load, { signal, automatic = false } = {}, delivery = {}) {
    signal?.throwIfAborted();
    let task = this.tasks.get(key);
    if (!task) {
      task = { controller: new AbortController(), consumers: new Set(), pending, delivery };
      this.tasks.set(key, task);
      const current = task;
      task.promise = Promise.resolve().then(() => load(current.controller.signal));
      pending.set(key, task.promise);
      task.promise.then(
        (value) => this.finish(key, current, true, value),
        (error) => this.finish(key, current, false, error),
      );
    }
    return new Promise((resolve, reject) => {
      const consumer = { signal, automatic, resolve, reject };
      const release = () => {
        signal?.removeEventListener("abort", consumer.cancel);
        task.consumers.delete(consumer);
      };
      consumer.release = release;
      consumer.cancel = () => {
        release();
        reject(signal.reason);
        if (!task.consumers.size) {
          task.controller.abort(signal.reason);
          this.remove(key, task);
        }
      };
      task.consumers.add(consumer);
      signal?.addEventListener("abort", consumer.cancel, { once: true });
    });
  }
  remove(key, task) {
    if (this.tasks.get(key) !== task) return;
    this.tasks.delete(key);
    task.pending.delete(key);
  }
  finish(key, task, success, value) {
    const current = this.tasks.get(key) === task && !task.controller.signal.aborted;
    this.remove(key, task);
    if (success && !current) {
      task.delivery.discard?.(value);
      return;
    }
    try {
      if (success) {
        const pin = (image) => {
          for (const consumer of task.consumers)
            if (consumer.signal) this.bank.pinLoadPage(key, image, consumer.signal);
        };
        // Publication and promise settlement share one synchronous ownership commit.
        task.delivery.publish?.(value, pin);
        this.failed.delete(key);
      } else if (current && !this.bank.disposed) {
        this.failed.add(key);
        const owners = [...task.consumers];
        const automaticOnly = owners.length > 0 && owners.every((owner) => owner.automatic);
        // Explicit callers own their rejected promise's UI error; report here only
        // when every remaining consumer is automatic, avoiding duplicate diagnostics.
        if (automaticOnly) this.onError(value);
      }
    } finally {
      // Observer exceptions remain visible without stranding consumers or retry latches.
      for (const consumer of task.consumers) {
        consumer.release();
        if (success) consumer.resolve(value);
        else consumer.reject(value);
      }
    }
  }
  dispose() {
    const error = new Error("Sprite bank is disposed.");
    for (const [key, task] of this.tasks) {
      task.controller.abort(error);
      this.finish(key, task, false, error);
    }
    this.failed.clear();
    this.automatic.clear();
  }
}
