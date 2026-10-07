import "server-only";

type Deferred = { done: Promise<void>; resolve: () => void };
type Task = Deferred & { running: boolean; rerun: Deferred | null };

function deferred(): Deferred {
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  return { done, resolve };
}

/**
 * In-process work queue keyed by id and shared fairly between groups (companies): each group has its own FIFO
 * list and the groups take turns, so one company's bulk upload can't hold up another's CVs.
 * An id that is already waiting isn't added twice; callers get the same completion promise. An id enqueued
 * while it is running runs once more straight after, so that run sees whatever changed in the meantime.
 * Completion promises always resolve, never reject.
 */
export class TaskQueue {
  /** Groups with waiting ids. Map order is turn order: a group that just had its turn moves to the back. */
  private readonly waiting = new Map<string, string[]>();
  private readonly tasks = new Map<string, Task>();
  private readonly idleWaiters: Array<() => void> = [];
  private running = 0;

  constructor(
    /** Reassignable so a dev hot reload can swap in the new implementation on the cached queue. */
    public worker: (id: string) => Promise<void>,
    private readonly concurrency: () => number,
  ) {}

  enqueue(id: string, group: string): Promise<void> {
    const existing = this.tasks.get(id);
    if (existing && !existing.running) return existing.done;
    if (existing) {
      existing.rerun ??= deferred();
      return existing.rerun.done;
    }

    const task: Task = { ...deferred(), running: false, rerun: null };
    this.tasks.set(id, task);
    const ids = this.waiting.get(group);
    if (ids) ids.push(id);
    else this.waiting.set(group, [id]);
    this.pump();
    return task.done;
  }

  /** Resolves once nothing is waiting or running. */
  onIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.running === 0 && this.waiting.size === 0;
  }

  private takeNext(): string | undefined {
    const first = this.waiting.entries().next();
    if (first.done) return undefined;
    const [group, ids] = first.value;
    const id = ids.shift();
    this.waiting.delete(group);
    if (ids.length > 0) this.waiting.set(group, ids);
    return id;
  }

  private pump(): void {
    const limit = Math.max(1, Math.floor(this.concurrency()));
    while (this.running < limit) {
      const id = this.takeNext();
      if (id === undefined) break;
      this.running++;
      void this.run(id);
    }
    if (this.isIdle()) this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }

  private async run(id: string): Promise<void> {
    const task = this.tasks.get(id)!;
    task.running = true;
    for (;;) {
      try {
        await this.worker(id);
      } catch (err) {
        console.error(`[pipeline] worker crashed for ${id}:`, err instanceof Error ? err.message : err);
      }
      if (!task.rerun) break;
      // Enqueued again while running: settle this run's callers, then go again in the same slot.
      task.resolve();
      Object.assign(task, task.rerun, { rerun: null });
    }
    this.running--;
    this.tasks.delete(id);
    task.resolve();
    this.pump();
  }
}
