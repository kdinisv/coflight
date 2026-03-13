# coflight

> Tiny TypeScript library for deduplicating concurrent async calls by key.
> One real request, many awaiters, zero duplicate work.

**English** | [Русский](README.ru.md)

## The Problem

When multiple parts of your application simultaneously request the same resource — the same API endpoint, database query, or expensive computation — each request triggers a separate operation. This wastes resources, increases latency, and can cause **cache stampede**.

**coflight** coalesces concurrent calls by key: the first caller triggers the real work, and all subsequent callers with the same key await the same result.

### Why not existing packages?

| Package                                                                | Problem                                                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`inflight`](https://www.npmjs.com/package/inflight)                   | **Deprecated**, known memory leaks, 60M+ weekly downloads as a zombie dependency |
| [`promise-inflight`](https://www.npmjs.com/package/promise-inflight)   | Last published 9 years ago, no tests                                             |
| [`node-singleflight`](https://www.npmjs.com/package/node-singleflight) | No timeout, memory leak risk with many listeners                                 |
| [`lru-cache`](https://www.npmjs.com/package/lru-cache)                 | Full cache engine — too heavy when all you need is dedup                         |

## Features

- **Zero dependencies**
- **First-class TypeScript** with full generic support
- **ESM + CJS** dual package
- **Per-subscriber `AbortSignal`** — each caller can independently cancel without affecting others
- **Timeout** per subscriber
- **Short TTL cache** — optionally cache results for a short period after completion
- **`staleIfError`** — return last successful result if the current operation fails
- **Node.js 18+**

## Install

```bash
npm install coflight
```

## Quick Start

```typescript
import { createCoflight } from "coflight";

interface User {
  id: string;
  name: string;
}

const users = createCoflight<string, User>();

// All concurrent calls with the same key share a single fetch
async function getUser(id: string, signal?: AbortSignal): Promise<User> {
  return users.run(
    `user:${id}`,
    ({ signal }) => fetch(`/api/users/${id}`, { signal }).then((r) => r.json()),
    { signal, timeout: 3000, ttl: 5000 },
  );
}
```

## API

### `createCoflight<K, V>()`

Creates a new coalescing group.

- `K` — key type (extends `string`, default `string`)
- `V` — value type (default `unknown`)

Returns a `CoflightGroup<K, V>`.

---

### `group.run(key, fn, options?)`

Execute `fn` for the given key, or join an already in-flight call.

- **`key: K`** — deduplication key.
- **`fn: (ctx: { signal: AbortSignal }) => Promise<V> | V`** — the function to execute. Only called for the **first** caller; subsequent callers share the same result.
- **`options?`** — see below.

Returns `Promise<V>`.

#### Options

| Option         | Type          | Description                                                                                             |
| -------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `signal`       | `AbortSignal` | Per-subscriber abort signal. Does **not** cancel the shared operation unless **all** subscribers abort. |
| `timeout`      | `number`      | Per-subscriber timeout in ms. Rejects with `TimeoutError` if exceeded.                                  |
| `ttl`          | `number`      | Cache the result for this many ms after completion. Set by the first caller.                            |
| `staleIfError` | `boolean`     | If `true` and the operation fails, return the last successful result for this key (if any).             |

---

### `group.forget(key)`

Remove `key` from the flight map, TTL cache, and stale result store. Existing subscribers continue to receive their result.

Returns `boolean` — `true` if the key was found.

---

### `group.clear()`

Remove all entries (flights, cache, stale results).

---

### `group.isRunning(key)`

Returns `boolean` — whether there is an in-flight operation for the key.

---

### `group.stats()`

Returns `{ inflight: number; cached: number }`.

## How It Works

```
Caller A ─┐
Caller B ─┼─→ run("user:42", fn) ─→ ONE fn() call ─→ result
Caller C ─┘                         │                   │
                                     └── all callers ←──┘
                                         get the same
                                         result
```

1. **First call** with a key starts the real operation.
2. **Subsequent calls** with the same key join the in-flight operation.
3. When the operation completes, **all callers receive the result**.
4. With `ttl`, the result is cached for a short period — no new operation runs.
5. Each caller can independently abort via their own `AbortSignal`.
6. Only when **all** callers have aborted is the shared operation cancelled.

## Abort Behaviour

Each subscriber can pass its own `AbortSignal`. When a subscriber aborts:

- That subscriber's promise rejects with `AbortError`.
- Other subscribers are **not affected**.
- The underlying operation continues as long as at least one subscriber remains.
- When **every** subscriber has aborted, the shared `AbortSignal` (passed to `fn`) is aborted too.

All internal listeners use `{ once: true }` to prevent memory leaks — no matter how many subscribers join.

## License

MIT
