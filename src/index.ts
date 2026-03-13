export interface CoflightOptions {
  /** Per-subscriber AbortSignal. Does not cancel the shared operation unless all subscribers abort. */
  signal?: AbortSignal;
  /** Per-subscriber timeout in milliseconds. Rejects with `TimeoutError` if exceeded. */
  timeout?: number;
  /** Cache the successful result for this many ms after the operation completes. Set by the first caller. */
  ttl?: number;
  /** If `true` and the operation fails, return the last successful result for this key (if any). */
  staleIfError?: boolean;
}

export interface CoflightContext {
  /** AbortSignal that is aborted only when every subscriber has cancelled. Pass it into fetch, DB calls, etc. */
  signal: AbortSignal;
}

export interface CoflightStats {
  /** Number of currently in-flight operations. */
  inflight: number;
  /** Number of cached (TTL) results. */
  cached: number;
}

export interface CoflightGroup<K extends string = string, V = unknown> {
  /**
   * Execute `fn` for the given `key`, or join an already in-flight call.
   * Only the **first** caller's `fn` is invoked; subsequent callers with the same key
   * await the same underlying promise.
   */
  run(
    key: K,
    fn: (ctx: CoflightContext) => Promise<V> | V,
    options?: CoflightOptions,
  ): Promise<V>;

  /** Remove `key` from the flight map, TTL cache, and stale store. Existing subscribers still receive their result. */
  forget(key: K): boolean;

  /** Remove all entries (flights, cache, stale results). */
  clear(): void;

  /** Whether an operation for `key` is currently in-flight. */
  isRunning(key: K): boolean;

  /** Snapshot of internal counters. */
  stats(): CoflightStats;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface Flight<V> {
  promise: Promise<V>;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
  ttl: number | undefined;
}

interface CacheEntry<V> {
  value: V;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCoflight<
  K extends string = string,
  V = unknown,
>(): CoflightGroup<K, V> {
  const flights = new Map<K, Flight<V>>();
  const cache = new Map<K, CacheEntry<V>>();
  const staleStore = new Map<K, V>();

  // -----------------------------------------------------------------------
  // run
  // -----------------------------------------------------------------------
  function run(
    key: K,
    fn: (ctx: CoflightContext) => Promise<V> | V,
    options?: CoflightOptions,
  ): Promise<V> {
    // 1. Serve from TTL cache
    const cached = cache.get(key);
    if (cached) return Promise.resolve(cached.value);

    // 2. Join existing flight or start a new one
    let flight = flights.get(key);
    if (!flight) {
      const controller = new AbortController();

      // Wrap fn so that synchronous throws become rejections
      const promise = new Promise<V>((resolve, reject) => {
        try {
          resolve(fn({ signal: controller.signal }));
        } catch (err) {
          reject(err);
        }
      });

      flight = {
        promise,
        controller,
        subscribers: 0,
        settled: false,
        ttl: options?.ttl,
      };

      flights.set(key, flight);

      // Flight completion bookkeeping (runs once, regardless of subscriber count)
      const f = flight;
      promise.then(
        (value) => {
          f.settled = true;
          staleStore.set(key, value);
          // Only touch the map / cache if *this* flight is still the current one
          // (forget + re-run could have replaced it).
          if (flights.get(key) === f) {
            flights.delete(key);
            if (f.ttl != null && f.ttl > 0) {
              const timer = setTimeout(() => {
                if (cache.get(key)?.timer === timer) cache.delete(key);
              }, f.ttl);
              unrefTimer(timer);
              cache.set(key, { value, timer });
            }
          }
        },
        () => {
          f.settled = true;
          if (flights.get(key) === f) flights.delete(key);
        },
      );
    }

    // 3. Register a new subscriber
    flight.subscribers++;
    const f = flight;

    return new Promise<V>((resolve, reject) => {
      let subscriberSettled = false;
      let tid: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (options?.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
        if (tid !== undefined) {
          clearTimeout(tid);
          tid = undefined;
        }
      };

      const settle = (action: () => void): void => {
        if (subscriberSettled) return;
        subscriberSettled = true;
        cleanup();
        action();
      };

      /** Decrement subscriber count; abort shared controller when nobody is left. */
      const leave = () => {
        f.subscribers--;
        if (f.subscribers <= 0 && !f.settled) {
          f.controller.abort();
        }
      };

      const onAbort = (): void =>
        settle(() => {
          leave();
          reject(
            options?.signal?.reason ??
              new DOMException("The operation was aborted.", "AbortError"),
          );
        });

      // Fast-path: signal already aborted before we subscribed
      if (options?.signal?.aborted) {
        settle(() => {
          leave();
          reject(
            options!.signal!.reason ??
              new DOMException("The operation was aborted.", "AbortError"),
          );
        });
        return;
      }

      // Per-subscriber abort listener (once: true to avoid leaks)
      if (options?.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      // Per-subscriber timeout
      if (options?.timeout != null && options.timeout > 0) {
        tid = setTimeout(
          () =>
            settle(() => {
              leave();
              reject(
                new DOMException("The operation timed out.", "TimeoutError"),
              );
            }),
          options.timeout,
        );
      }

      // Wait for the shared flight to complete
      f.promise.then(
        (value) => settle(() => resolve(value)),
        (error) =>
          settle(() => {
            if (options?.staleIfError && staleStore.has(key)) {
              resolve(staleStore.get(key) as V);
              return;
            }
            reject(error);
          }),
      );
    });
  }

  // -----------------------------------------------------------------------
  // forget / clear / isRunning / stats
  // -----------------------------------------------------------------------

  function forget(key: K): boolean {
    const hadFlight = flights.delete(key);
    const entry = cache.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      cache.delete(key);
    }
    const hadStale = staleStore.delete(key);
    return hadFlight || !!entry || hadStale;
  }

  function clear(): void {
    flights.clear();
    for (const entry of cache.values()) clearTimeout(entry.timer);
    cache.clear();
    staleStore.clear();
  }

  function isRunning(key: K): boolean {
    return flights.has(key);
  }

  function stats(): CoflightStats {
    return { inflight: flights.size, cached: cache.size };
  }

  return { run, forget, clear, isRunning, stats };
}
