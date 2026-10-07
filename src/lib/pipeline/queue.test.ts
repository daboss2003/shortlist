import { describe, expect, it, vi } from "vitest";
import { TaskQueue } from "./queue";

/** A worker whose runs finish only when the test releases them, recording the order runs start in. */
function controlledWorker() {
  const started: string[] = [];
  const pending: Array<() => void> = [];
  const worker = vi.fn((id: string) => {
    started.push(id);
    return new Promise<void>((resolve) => pending.push(resolve));
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  /** Finishes the oldest unfinished run, then lets the queue start the next. */
  const finishNext = async () => {
    pending.shift()?.();
    await settle();
  };
  return { worker, started, finishNext, settle };
}

describe("TaskQueue", () => {
  it("lets companies take turns, so a big batch doesn't hold up another company's CV", async () => {
    const { worker, started, finishNext } = controlledWorker();
    const queue = new TaskQueue(worker, () => 1);

    for (let i = 1; i <= 10; i++) void queue.enqueue(`a${i}`, "company-a");
    void queue.enqueue("b1", "company-b");
    while (started.length < 11) await finishNext();
    await finishNext();
    await queue.onIdle();

    expect(started.indexOf("b1")).toBeLessThan(started.indexOf("a3"));
    expect(started.filter((id) => id.startsWith("a"))).toEqual(Array.from({ length: 10 }, (_, i) => `a${i + 1}`));
  });

  it("alternates between companies that both have work waiting", async () => {
    const { worker, started, finishNext } = controlledWorker();
    const queue = new TaskQueue(worker, () => 1);

    void queue.enqueue("a1", "a");
    for (const id of ["a2", "a3", "a4"]) void queue.enqueue(id, "a");
    for (const id of ["b1", "b2"]) void queue.enqueue(id, "b");
    void queue.enqueue("c1", "c");
    while (started.length < 7) await finishNext();
    await finishNext();

    expect(started).toEqual(["a1", "a2", "b1", "c1", "a3", "b2", "a4"]);
  });

  it("keeps the concurrency limit", async () => {
    const { worker, started, finishNext, settle } = controlledWorker();
    const queue = new TaskQueue(worker, () => 2);

    for (const id of ["a1", "a2", "b1", "b2"]) void queue.enqueue(id, id[0]);
    await settle();
    expect(started).toHaveLength(2);
    await finishNext();
    expect(started).toHaveLength(3);
    while (started.length < 4) await finishNext();
    await finishNext();
    await finishNext();
    await queue.onIdle();
  });

  it("doesn't add an id that is already waiting", async () => {
    const { worker, finishNext } = controlledWorker();
    const queue = new TaskQueue(worker, () => 1);

    void queue.enqueue("a1", "a");
    const first = queue.enqueue("a2", "a");
    const second = queue.enqueue("a2", "a");
    expect(second).toBe(first);
    await finishNext();
    await finishNext();
    await queue.onIdle();

    expect(worker.mock.calls.map(([id]) => id)).toEqual(["a1", "a2"]);
  });

  it("runs an id once more, straight after, when it's enqueued while running", async () => {
    const { worker, started, finishNext, settle } = controlledWorker();
    const queue = new TaskQueue(worker, () => 1);

    const firstRun = queue.enqueue("a1", "a");
    void queue.enqueue("b1", "b");
    await settle();
    const rerun = queue.enqueue("a1", "a");
    expect(queue.enqueue("a1", "a")).toBe(rerun);
    let rerunDone = false;
    void rerun.then(() => (rerunDone = true));

    await finishNext();
    await firstRun;
    expect(started).toEqual(["a1", "a1"]);
    expect(rerunDone).toBe(false);

    await finishNext();
    expect(rerunDone).toBe(true);
    await finishNext();
    await queue.onIdle();
    expect(started).toEqual(["a1", "a1", "b1"]);
  });

  it("keeps going, and resolves the caller, when a worker throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = vi.fn(async (id: string) => {
      if (id === "bad") throw new Error("boom");
    });
    const queue = new TaskQueue(worker, () => 1);

    await expect(queue.enqueue("bad", "a")).resolves.toBeUndefined();
    await expect(queue.enqueue("good", "a")).resolves.toBeUndefined();
    expect(worker).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});
