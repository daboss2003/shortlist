import "server-only";

type Task = { done: Promise<void>; resolve: () => void };

/**
 * In-process FIFO work queue keyed by id. An id that is already waiting or running isn't added twice;
 * callers get the same completion promise. Completion promises always resolve, never reject.
 */
export class TaskQueue {
  private readonly waiting: string[] = [];
  private readonly tasks = new Map<string, Task>();
  private readonly idleWaiters: Array<() => void> = [];
  private running = 0;

  constructor(
    /** Reassignable so a dev hot reload can swap in the new implementation on the cached queue. */
    public worker: (id: string) => Promise<void>,
    private readonly concurrency: () => number,
  ) {}

  enqueue(id: string): Promise<void> {
    const existing = this.tasks.get(id);
    if (existing) return existing.done;

    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    this.tasks.set(id, { done, resolve });
    this.waiting.push(id);
    this.pump();
    return done;
  }

  /** Resolves once nothing is waiting or running. */
  onIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.running === 0 && this.waiting.length === 0;
  }

  private pump(): void {
    const limit = Math.max(1, Math.floor(this.concurrency()));
    while (this.running < limit && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      this.running++;
      void this.run(id);
    }
    if (this.isIdle()) this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }

  private async run(id: string): Promise<void> {
    try {
      await this.worker(id);
    } catch (err) {
      console.error(`[pipeline] worker crashed for ${id}:`, err instanceof Error ? err.message : err);
    } finally {
      this.running--;
      this.tasks.get(id)?.resolve();
      this.tasks.delete(id);
      this.pump();
    }
  }
}
