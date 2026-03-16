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

export interface CoflightCreateOptions {
  /** Maximum time to keep stale results in milliseconds. Omit to keep them until forgotten or replaced. Set to `0` to disable stale retention. */
  staleTtl?: number;
  /** Maximum number of stale results to keep. Omit to keep an unlimited number. Set to `0` to disable stale retention. */
  maxStaleEntries?: number;
}

export interface CoflightWarmOptions {
  /** Cache the warmed value for this many ms. Omit or set to `0` to skip TTL cache seeding. */
  ttl?: number;
  /** Also seed the stale store with the warmed value. Defaults to `true`. */
  stale?: boolean;
}

export interface CoflightContext {
  /** AbortSignal that is aborted only when every subscriber has cancelled. Pass it into fetch, DB calls, etc. */
  signal: AbortSignal;
}

export type CoflightResultSource = "fresh" | "shared" | "cache" | "stale";

export interface CoflightRunResult<V> {
  /** Resolved value for this subscriber. */
  value: V;
  /** Where this subscriber received the value from. */
  source: CoflightResultSource;
}

export interface CoflightStats {
  /** Number of currently in-flight operations. */
  inflight: number;
  /** Number of cached (TTL) results. */
  cached: number;
  /** Number of retained stale results. */
  stale: number;
  /** Total subscriber calls made through `run` or `runDetailed`. */
  requests: number;
  /** Number of times a new underlying operation was started. */
  freshRuns: number;
  /** Number of subscribers that joined an existing in-flight operation. */
  sharedRuns: number;
  /** Number of results served directly from the TTL cache. */
  cacheHits: number;
  /** Number of subscribers that received a stale fallback after an error. */
  staleHits: number;
  /** Number of successful cache warm-ups. */
  warmups: number;
  /** Number of subscribers aborted by their own signal. */
  aborts: number;
  /** Number of subscribers rejected by timeout. */
  timeouts: number;
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

  /** Like `run`, but also reports whether the value came from fresh work, a shared flight, cache, or stale fallback. */
  runDetailed(
    key: K,
    fn: (ctx: CoflightContext) => Promise<V> | V,
    options?: CoflightOptions,
  ): Promise<CoflightRunResult<V>>;

  /** Seed cache and stale storage for a key before traffic arrives. Returns `false` if nothing was written. */
  warm(key: K, value: V, options?: CoflightWarmOptions): boolean;

  /** Remove `key` from the flight map, TTL cache, and stale store. Existing subscribers still receive their result. */
  forget(key: K): boolean;

  /** Remove all entries (flights, cache, stale results). */
  clear(): void;

  /** Whether an operation for `key` is currently in-flight. */
  isRunning(key: K): boolean;

  /** Snapshot of live counts and cumulative runtime counters. */
  stats(): CoflightStats;
}

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

interface StaleEntry<V> {
  value: V;
  expiresAt: number | null;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
}

function hasPositiveDuration(value: number | undefined): value is number {
  return value != null && value > 0;
}

export function createCoflight<K extends string = string, V = unknown>(
  options: CoflightCreateOptions = {},
): CoflightGroup<K, V> {
  const flights = new Map<K, Flight<V>>();
  const cache = new Map<K, CacheEntry<V>>();
  const staleStore = new Map<K, StaleEntry<V>>();
  const counters = {
    requests: 0,
    freshRuns: 0,
    sharedRuns: 0,
    cacheHits: 0,
    staleHits: 0,
    warmups: 0,
    aborts: 0,
    timeouts: 0,
  };

  function clearCacheEntry(key: K): boolean {
    const entry = cache.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    cache.delete(key);
    return true;
  }

  function storeCachedValue(
    key: K,
    value: V,
    ttl: number | undefined,
  ): boolean {
    clearCacheEntry(key);
    if (!hasPositiveDuration(ttl)) return false;

    const timer = setTimeout(() => {
      if (cache.get(key)?.timer === timer) cache.delete(key);
    }, ttl);
    unrefTimer(timer);
    cache.set(key, { value, timer });
    return true;
  }

  function pruneStaleLimit(): void {
    const maxStaleEntries = options.maxStaleEntries;
    if (maxStaleEntries == null) return;

    if (maxStaleEntries <= 0) {
      staleStore.clear();
      return;
    }

    while (staleStore.size > maxStaleEntries) {
      const oldestKey = staleStore.keys().next().value as K | undefined;
      if (oldestKey === undefined) return;
      staleStore.delete(oldestKey);
    }
  }

  function sweepExpiredStale(): void {
    if (staleStore.size === 0) return;

    const now = Date.now();
    for (const [key, entry] of staleStore) {
      if (entry.expiresAt != null && entry.expiresAt <= now) {
        staleStore.delete(key);
      }
    }
  }

  function getStaleValue(key: K): V | undefined {
    const entry = staleStore.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
      staleStore.delete(key);
      return undefined;
    }

    return entry.value;
  }

  function storeStaleValue(key: K, value: V): boolean {
    const staleTtl = options.staleTtl;
    const maxStaleEntries = options.maxStaleEntries;

    if (
      (staleTtl != null && staleTtl <= 0) ||
      (maxStaleEntries != null && maxStaleEntries <= 0)
    ) {
      staleStore.delete(key);
      return false;
    }

    const expiresAt = staleTtl == null ? null : Date.now() + staleTtl;
    staleStore.delete(key);
    staleStore.set(key, { value, expiresAt });
    pruneStaleLimit();
    return true;
  }

  function run(
    key: K,
    fn: (ctx: CoflightContext) => Promise<V> | V,
    options?: CoflightOptions,
  ): Promise<V> {
    return runDetailed(key, fn, options).then((result) => result.value);
  }

  function runDetailed(
    key: K,
    fn: (ctx: CoflightContext) => Promise<V> | V,
    options?: CoflightOptions,
  ): Promise<CoflightRunResult<V>> {
    counters.requests++;

    const cached = cache.get(key);
    if (cached) {
      counters.cacheHits++;
      return Promise.resolve({ value: cached.value, source: "cache" });
    }

    let source: CoflightResultSource = "fresh";
    let flight = flights.get(key);

    if (!flight) {
      counters.freshRuns++;
      const controller = new AbortController();
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

      const currentFlight = flight;
      promise.then(
        (value) => {
          currentFlight.settled = true;
          storeStaleValue(key, value);
          if (flights.get(key) === currentFlight) {
            flights.delete(key);
            storeCachedValue(key, value, currentFlight.ttl);
          }
        },
        () => {
          currentFlight.settled = true;
          if (flights.get(key) === currentFlight) flights.delete(key);
        },
      );
    } else {
      source = "shared";
      counters.sharedRuns++;
    }

    flight.subscribers++;
    const currentFlight = flight;

    return new Promise<CoflightRunResult<V>>((resolve, reject) => {
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

      const leave = () => {
        currentFlight.subscribers--;
        if (currentFlight.subscribers <= 0 && !currentFlight.settled) {
          currentFlight.controller.abort();
        }
      };

      const onAbort = (): void =>
        settle(() => {
          leave();
          counters.aborts++;
          reject(
            options?.signal?.reason ??
              new DOMException("The operation was aborted.", "AbortError"),
          );
        });

      if (options?.signal?.aborted) {
        settle(() => {
          leave();
          counters.aborts++;
          reject(
            options?.signal?.reason ??
              new DOMException("The operation was aborted.", "AbortError"),
          );
        });
        return;
      }

      if (options?.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      if (hasPositiveDuration(options?.timeout)) {
        tid = setTimeout(
          () =>
            settle(() => {
              leave();
              counters.timeouts++;
              reject(
                new DOMException("The operation timed out.", "TimeoutError"),
              );
            }),
          options.timeout,
        );
      }

      currentFlight.promise.then(
        (value) => settle(() => resolve({ value, source })),
        (error) =>
          settle(() => {
            if (options?.staleIfError) {
              const staleValue = getStaleValue(key);
              if (staleValue !== undefined) {
                counters.staleHits++;
                resolve({ value: staleValue, source: "stale" });
                return;
              }
            }
            reject(error);
          }),
      );
    });
  }

  function warm(key: K, value: V, options?: CoflightWarmOptions): boolean {
    if (flights.has(key)) return false;

    const cached = storeCachedValue(key, value, options?.ttl);
    const stale =
      options?.stale === false ? false : storeStaleValue(key, value);

    if (!cached && !stale) return false;

    counters.warmups++;
    return true;
  }

  function forget(key: K): boolean {
    const hadFlight = flights.delete(key);
    const hadCache = clearCacheEntry(key);
    const hadStale = staleStore.delete(key);
    return hadFlight || hadCache || hadStale;
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
    sweepExpiredStale();

    return {
      inflight: flights.size,
      cached: cache.size,
      stale: staleStore.size,
      requests: counters.requests,
      freshRuns: counters.freshRuns,
      sharedRuns: counters.sharedRuns,
      cacheHits: counters.cacheHits,
      staleHits: counters.staleHits,
      warmups: counters.warmups,
      aborts: counters.aborts,
      timeouts: counters.timeouts,
    };
  }

  return { run, runDetailed, warm, forget, clear, isRunning, stats };
}
