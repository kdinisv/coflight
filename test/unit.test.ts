import { describe, it, expect, vi, afterEach } from "vitest";
import { createCoflight } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Basic deduplication
// ---------------------------------------------------------------------------

describe("basic deduplication", () => {
  it("coalesces concurrent calls with the same key", async () => {
    const group = createCoflight<string, number>();
    let callCount = 0;
    const fn = async () => {
      callCount++;
      await delay(50);
      return 42;
    };

    const [a, b, c] = await Promise.all([
      group.run("key", fn),
      group.run("key", fn),
      group.run("key", fn),
    ]);

    expect(callCount).toBe(1);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(c).toBe(42);
  });

  it("does not coalesce calls with different keys", async () => {
    const group = createCoflight<string, number>();
    let callCount = 0;
    const fn = async () => ++callCount;

    const [a, b] = await Promise.all([
      group.run("key-1", fn),
      group.run("key-2", fn),
    ]);

    expect(callCount).toBe(2);
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("starts a new flight after the previous one completes", async () => {
    const group = createCoflight<string, number>();
    let callCount = 0;
    const fn = async () => ++callCount;

    const first = await group.run("key", fn);
    const second = await group.run("key", fn);

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(callCount).toBe(2);
  });

  it("handles synchronous return values", async () => {
    const group = createCoflight<string, number>();
    const result = await group.run("key", () => 99);
    expect(result).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

describe("forget", () => {
  it("removes in-flight entry so the next call starts a new flight", async () => {
    const group = createCoflight<string, number>();
    let callCount = 0;
    const fn = async () => {
      callCount++;
      await delay(50);
      return callCount;
    };

    const p1 = group.run("key", fn);
    expect(group.isRunning("key")).toBe(true);

    group.forget("key");
    expect(group.isRunning("key")).toBe(false);

    // Existing subscriber still resolves
    const result1 = await p1;
    expect(result1).toBe(1);

    // A new call creates a fresh flight
    const result2 = await group.run("key", fn);
    expect(result2).toBe(2);
    expect(callCount).toBe(2);
  });

  it("removes cached entry", async () => {
    const group = createCoflight<string, number>();
    await group.run("key", async () => 1, { ttl: 10_000 });
    expect(group.stats().cached).toBe(1);

    group.forget("key");
    expect(group.stats().cached).toBe(0);
  });

  it("returns false for unknown key", () => {
    const group = createCoflight<string, number>();
    expect(group.forget("nope")).toBe(false);
  });

  it("returns true when key existed", async () => {
    const group = createCoflight<string, number>();
    const p = group.run("key", () => delay(50).then(() => 1));
    expect(group.forget("key")).toBe(true);
    await p;
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe("clear", () => {
  it("removes all flights and cached entries", async () => {
    const group = createCoflight<string, number>();

    const p1 = group.run("a", () => delay(50).then(() => 1));
    const p2 = group.run("b", () => delay(50).then(() => 2));

    expect(group.stats().inflight).toBe(2);
    group.clear();
    expect(group.stats()).toEqual({ inflight: 0, cached: 0 });

    // Let existing promises settle
    await Promise.all([p1, p2]);
  });
});

// ---------------------------------------------------------------------------
// isRunning
// ---------------------------------------------------------------------------

describe("isRunning", () => {
  it("returns true while in-flight, false after completion", async () => {
    const group = createCoflight<string, number>();

    expect(group.isRunning("key")).toBe(false);
    const p = group.run("key", () => delay(50).then(() => 1));
    expect(group.isRunning("key")).toBe(true);
    await p;
    expect(group.isRunning("key")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

describe("stats", () => {
  it("reports inflight and cached counts", async () => {
    const group = createCoflight<string, number>();
    expect(group.stats()).toEqual({ inflight: 0, cached: 0 });

    const p = group.run("key", () => delay(30).then(() => 1), { ttl: 5000 });
    expect(group.stats().inflight).toBe(1);

    await p;
    expect(group.stats()).toEqual({ inflight: 0, cached: 1 });
  });
});

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

describe("TTL", () => {
  it("serves cached result within TTL window", async () => {
    const group = createCoflight<string, number>();
    let callCount = 0;

    await group.run("key", async () => ++callCount, { ttl: 500 });
    expect(callCount).toBe(1);

    const cached = await group.run("key", async () => ++callCount);
    expect(cached).toBe(1);
    expect(callCount).toBe(1);
  });

  it("expires after TTL elapses", async () => {
    vi.useFakeTimers();
    const group = createCoflight<string, number>();
    let callCount = 0;

    await group.run("key", async () => ++callCount, { ttl: 100 });
    expect(callCount).toBe(1);

    vi.advanceTimersByTime(150);

    await group.run("key", async () => ++callCount, { ttl: 100 });
    expect(callCount).toBe(2);
  });

  it("does not cache when ttl is 0", async () => {
    const group = createCoflight<string, number>();
    let callCount = 0;

    await group.run("key", async () => ++callCount, { ttl: 0 });
    await group.run("key", async () => ++callCount, { ttl: 0 });

    expect(callCount).toBe(2);
    expect(group.stats().cached).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal
// ---------------------------------------------------------------------------

describe("AbortSignal", () => {
  it("rejects when subscriber signal is aborted", async () => {
    const group = createCoflight<string, number>();
    const ac = new AbortController();

    const p = group.run("key", () => delay(200).then(() => 1), {
      signal: ac.signal,
    });

    ac.abort();

    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately with already-aborted signal", async () => {
    const group = createCoflight<string, number>();
    const ac = new AbortController();
    ac.abort();

    await expect(
      group.run("key", async () => 1, { signal: ac.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts shared signal when ALL subscribers abort", async () => {
    const group = createCoflight<string, number>();
    let sharedSignal: AbortSignal | null = null;

    const fn = async ({ signal }: { signal: AbortSignal }) => {
      sharedSignal = signal;
      await delay(200);
      return 1;
    };

    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const p1 = group.run("key", fn, { signal: ac1.signal });
    const p2 = group.run("key", fn, { signal: ac2.signal });

    ac1.abort();
    ac2.abort();

    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    await expect(p2).rejects.toMatchObject({ name: "AbortError" });

    expect(sharedSignal!.aborted).toBe(true);
  });

  it("does NOT abort shared signal when only some subscribers abort", async () => {
    const group = createCoflight<string, number>();
    let sharedSignalAborted = false;

    const fn = async ({ signal }: { signal: AbortSignal }) => {
      await delay(50);
      sharedSignalAborted = signal.aborted;
      return 42;
    };

    const ac = new AbortController();
    const p1 = group.run("key", fn, { signal: ac.signal });
    const p2 = group.run("key", fn);

    ac.abort();

    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    const result = await p2;

    expect(result).toBe(42);
    expect(sharedSignalAborted).toBe(false);
  });

  it("propagates custom abort reason", async () => {
    const group = createCoflight<string, number>();
    const ac = new AbortController();
    const reason = new Error("custom reason");

    const p = group.run("key", () => delay(200).then(() => 1), {
      signal: ac.signal,
    });

    ac.abort(reason);

    const err = await p.catch((e: unknown) => e);
    expect(err).toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("timeout", () => {
  it("rejects after timeout", async () => {
    const group = createCoflight<string, number>();

    await expect(
      group.run("key", () => delay(500).then(() => 1), { timeout: 30 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("resolves normally if operation finishes before timeout", async () => {
    const group = createCoflight<string, number>();

    const result = await group.run("key", () => delay(10).then(() => 42), {
      timeout: 2000,
    });

    expect(result).toBe(42);
  });

  it("does not abort shared operation when only timed-out subscriber leaves", async () => {
    const group = createCoflight<string, number>();
    let sharedAborted = false;

    const fn = async ({ signal }: { signal: AbortSignal }) => {
      await delay(100);
      sharedAborted = signal.aborted;
      return 42;
    };

    const p1 = group.run("key", fn, { timeout: 20 });
    const p2 = group.run("key", fn);

    await expect(p1).rejects.toMatchObject({ name: "TimeoutError" });
    const result = await p2;

    expect(result).toBe(42);
    expect(sharedAborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// staleIfError
// ---------------------------------------------------------------------------

describe("staleIfError", () => {
  it("returns last successful result when the new call fails", async () => {
    const group = createCoflight<string, number>();
    let callCount = 0;

    // First call succeeds
    await group.run("key", async () => {
      callCount++;
      return 42;
    });

    // Second call fails — staleIfError returns previous result
    const result = await group.run(
      "key",
      async () => {
        callCount++;
        throw new Error("boom");
      },
      { staleIfError: true },
    );

    expect(result).toBe(42);
    expect(callCount).toBe(2);
  });

  it("rejects if no stale result is available", async () => {
    const group = createCoflight<string, number>();

    await expect(
      group.run(
        "key",
        async () => {
          throw new Error("boom");
        },
        { staleIfError: true },
      ),
    ).rejects.toThrow("boom");
  });

  it("works per-subscriber (only the one opting in gets stale)", async () => {
    const group = createCoflight<string, number>();

    // Seed a stale result
    await group.run("key", async () => 42);

    // Both subscribers join a failing flight
    const failing = async () => {
      await delay(30);
      throw new Error("fail");
    };

    const [withStale, withoutStale] = await Promise.allSettled([
      group.run("key", failing, { staleIfError: true }),
      group.run("key", failing, { staleIfError: false }),
    ]);

    expect(withStale).toEqual({ status: "fulfilled", value: 42 });
    expect(withoutStale.status).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe("error propagation", () => {
  it("rejects all subscribers with the same error", async () => {
    const group = createCoflight<string, number>();
    const fn = async () => {
      await delay(30);
      throw new Error("shared error");
    };

    const results = await Promise.allSettled([
      group.run("key", fn),
      group.run("key", fn),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
    expect((results[0] as PromiseRejectedResult).reason.message).toBe(
      "shared error",
    );
  });

  it("handles synchronous throws in fn", async () => {
    const group = createCoflight<string, number>();

    await expect(
      group.run("key", () => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
  });

  it("allows a new flight after an error", async () => {
    const group = createCoflight<string, number>();
    let callCount = 0;

    await group
      .run("key", async () => {
        callCount++;
        throw new Error("first");
      })
      .catch(() => {});

    const result = await group.run("key", async () => {
      callCount++;
      return 99;
    });

    expect(callCount).toBe(2);
    expect(result).toBe(99);
  });
});
