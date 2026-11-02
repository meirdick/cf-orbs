import { describe, expect, it } from "vitest";
import { ExclusiveQueue } from "../src/orb/exclusive";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("ExclusiveQueue", () => {
  it("runs two concurrent ops in order, never overlapping", async () => {
    const q = new ExclusiveQueue();
    const log: string[] = [];
    const job = (name: string, steps: number) => async () => {
      log.push(`${name} start`);
      for (let i = 0; i < steps; i++) await tick();
      log.push(`${name} end`);
      return name;
    };
    const [a, b] = await Promise.all([q.run(job("a", 3)), q.run(job("b", 1))]);
    expect([a, b]).toEqual(["a", "b"]);
    expect(log).toEqual(["a start", "a end", "b start", "b end"]);
  });

  it("a rejection reaches only its caller and does not block later jobs", async () => {
    const q = new ExclusiveQueue();
    const bad = q.run(async () => {
      throw new Error("boom");
    });
    const good = q.run(async () => 42);
    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe(42);
  });

  it("counts pending jobs", async () => {
    const q = new ExclusiveQueue();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = q.run(() => gate);
    const b = q.run(async () => 1);
    expect(q.pending).toBe(2);
    release();
    await Promise.all([a, b]);
    expect(q.pending).toBe(0);
  });
});
