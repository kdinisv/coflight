import { describe, it, expect } from "vitest";
import { createCoflight } from "../src/index.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function liveStats(group: {
  stats: () => { inflight: number; cached: number; stale: number };
}): { inflight: number; cached: number; stale: number } {
  const { inflight, cached, stale } = group.stats();
  return { inflight, cached, stale };
}

// ---------------------------------------------------------------------------
// Concurrency stress
// ---------------------------------------------------------------------------

describe("stress: concurrency", () => {
  it("1 000 concurrent callers on the same key — single execution", async () => {
    const group = createCoflight<string, number>();
    let callCount = 0;

    const fn = async () => {
      callCount++;
      await delay(20);
      return 42;
    };

    const promises = Array.from({ length: 1_000 }, () => group.run("key", fn));

    const results = await Promise.all(promises);

    expect(callCount).toBe(1);
    expect(results.every((r) => r === 42)).toBe(true);
    expect(group.stats().inflight).toBe(0);
  });

  it("100 distinct keys in parallel", async () => {
    const group = createCoflight<string, string>();

    const promises = Array.from({ length: 100 }, (_, i) =>
      group.run(`key-${i}`, async () => {
        await delay(10);
        return `result-${i}`;
      }),
    );

    const results = await Promise.all(promises);

    expect(results.length).toBe(100);
    results.forEach((r, i) => expect(r).toBe(`result-${i}`));
    expect(group.stats().inflight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Abort storm
// ---------------------------------------------------------------------------

describe("stress: abort storm", () => {
  it("50 aborting subscribers + 1 survivor — operation completes", async () => {
    const group = createCoflight<string, number>();
    let fnCompleted = false;

    const fn = async ({ signal }: { signal: AbortSignal }) => {
      await delay(80);
      fnCompleted = !signal.aborted;
      return 1;
    };

    const controllers = Array.from({ length: 50 }, () => new AbortController());
    const aborting = controllers.map((ac) =>
      group.run("key", fn, { signal: ac.signal }),
    );

    // One subscriber without an abort signal — the "survivor"
    const survivor = group.run("key", fn);

    // Abort everyone else
    controllers.forEach((ac) => ac.abort());

    const abortResults = await Promise.allSettled(aborting);
    expect(abortResults.every((r) => r.status === "rejected")).toBe(true);

    const value = await survivor;
    expect(value).toBe(1);
    expect(fnCompleted).toBe(true);
  });

  it("all subscribers abort — shared operation is cancelled", async () => {
    const group = createCoflight<string, number>();
    let sharedSignal: AbortSignal | null = null;

    const fn = async ({ signal }: { signal: AbortSignal }) => {
      sharedSignal = signal;
      await delay(200);
      return 1;
    };

    const controllers = Array.from({ length: 20 }, () => new AbortController());
    const promises = controllers.map((ac) =>
      group.run("key", fn, { signal: ac.signal }),
    );

    controllers.forEach((ac) => ac.abort());

    const results = await Promise.allSettled(promises);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(sharedSignal!.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sequential batches (no leak check)
// ---------------------------------------------------------------------------

describe("stress: sequential batches", () => {
  it("100 sequential batches of 10 — no flights leak", async () => {
    const group = createCoflight<string, number>();
    let totalCalls = 0;

    for (let batch = 0; batch < 100; batch++) {
      const promises = Array.from({ length: 10 }, () =>
        group.run("key", async () => {
          totalCalls++;
          await delay(5);
          return totalCalls;
        }),
      );
      await Promise.all(promises);
    }

    // Each batch coalesces into 1 call
    expect(totalCalls).toBe(100);
    expect(liveStats(group)).toEqual({ inflight: 0, cached: 0, stale: 1 });
  });
});

// ---------------------------------------------------------------------------
// Mixed operations
// ---------------------------------------------------------------------------

describe("stress: mixed operations", () => {
  it("interleaved run / forget / run cycles", async () => {
    const group = createCoflight<string, number>();
    let callCount = 0;

    for (let i = 0; i < 50; i++) {
      const p = group.run("key", async () => {
        callCount++;
        await delay(10);
        return callCount;
      });

      // Forget mid-flight every other iteration
      if (i % 2 === 0) group.forget("key");

      await p;
    }

    expect(group.stats().inflight).toBe(0);
    // callCount ≥ 50 because forget causes re-flights
    expect(callCount).toBeGreaterThanOrEqual(50);
  });

  it("TTL + concurrent access does not corrupt state", async () => {
    const group = createCoflight<string, number>();
    let callCount = 0;

    // Start a flight with TTL
    const first = group.run(
      "key",
      async () => {
        callCount++;
        await delay(20);
        return 100;
      },
      { ttl: 200 },
    );

    // More subscribers join
    const joined = Array.from({ length: 20 }, () =>
      group.run("key", async () => ++callCount, { ttl: 200 }),
    );

    const results = await Promise.all([first, ...joined]);
    expect(results.every((r) => r === 100)).toBe(true);
    expect(callCount).toBe(1);

    // Within TTL — should be cached
    const cached = await group.run("key", async () => ++callCount);
    expect(cached).toBe(100);
    expect(callCount).toBe(1);
  });
});
