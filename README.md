# coflight

> Tiny TypeScript library for deduplicating concurrent async calls by key.
> One real request, many awaiters, zero duplicate work.

**English** | [Русский](#coflight-на-русском)

---

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
npm install @kdinisv/coflight
```

## Quick Start

```typescript
import { createCoflight } from "@kdinisv/coflight";

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
                                         get the same result
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

## Usage Examples

### API request deduplication

```typescript
import { createCoflight } from "@kdinisv/coflight";

const api = createCoflight<string, any>();

app.get("/users/:id", async (req, res) => {
  const user = await api.run(
    `user:${req.params.id}`,
    ({ signal }) => db.users.findById(req.params.id, { signal }),
    { timeout: 5000, ttl: 2000 },
  );
  res.json(user);
});
```

### SSR data loading

```typescript
const loaders = createCoflight<string, PageData>();

async function renderPage(slug: string): Promise<string> {
  const data = await loaders.run(`page:${slug}`, () => fetchPageData(slug), {
    ttl: 10_000,
    staleIfError: true,
  });
  return template(data);
}
```

### Cron overlap protection

```typescript
const jobs = createCoflight<string, void>();

// Even if cron fires twice — work runs once
cron.schedule("*/5 * * * *", () => {
  jobs.run("sync-orders", () => syncOrders());
});
```

### Per-subscriber abort in WebSocket

```typescript
const flights = createCoflight<string, Report>();

ws.on("message", async (msg) => {
  const ac = new AbortController();
  ws.once("cancel", () => ac.abort());

  try {
    const report = await flights.run(
      `report:${msg.id}`,
      ({ signal }) => generateReport(msg.id, { signal }),
      { signal: ac.signal, timeout: 30_000 },
    );
    ws.send(JSON.stringify(report));
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    ws.send(JSON.stringify({ error: "failed" }));
  }
});
```

## License

MIT

---

---

# coflight (на русском)

[English](#coflight) | **Русский**

> Компактная TypeScript-библиотека для дедупликации параллельных async-вызовов по ключу.
> Один реальный запрос, множество ожидающих, ноль дублирующей работы.

---

## Проблема

Когда несколько частей приложения одновременно запрашивают один и тот же ресурс — тот же API-эндпоинт, запрос к БД или тяжёлое вычисление — каждый запрос запускает отдельную операцию. Это расходует ресурсы, увеличивает задержки и может вызвать **cache stampede** (лавинный перезапрос).

**coflight** объединяет параллельные вызовы по ключу: первый вызов запускает реальную работу, а все последующие с тем же ключом ждут и получают тот же результат.

### Почему не существующие пакеты?

| Пакет                                                                  | Проблема                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`inflight`](https://www.npmjs.com/package/inflight)                   | **Deprecated**, известные утечки памяти, 60M+ скачиваний в неделю как зомби-зависимость |
| [`promise-inflight`](https://www.npmjs.com/package/promise-inflight)   | Последняя публикация 9 лет назад, тестов нет                                            |
| [`node-singleflight`](https://www.npmjs.com/package/node-singleflight) | Нет timeout, риск утечки памяти при большом числе listener'ов                           |
| [`lru-cache`](https://www.npmjs.com/package/lru-cache)                 | Полноценный кеш-движок — слишком тяжёлый, когда нужен только dedup                      |

## Возможности

- **Ноль зависимостей**
- **Полноценная поддержка TypeScript** с дженериками
- **ESM + CJS** — двойной формат пакета
- **Per-subscriber `AbortSignal`** — каждый вызывающий может отменить свой запрос независимо от других
- **Timeout** для каждого подписчика
- **Короткий TTL-кеш** — возможность кешировать результат на заданное время после завершения
- **`staleIfError`** — вернуть последний успешный результат, если текущая операция упала
- **Node.js 18+**

## Установка

```bash
npm install @kdinisv/coflight
```

## Быстрый старт

```typescript
import { createCoflight } from "@kdinisv/coflight";

interface User {
  id: string;
  name: string;
}

const users = createCoflight<string, User>();

// Все параллельные вызовы с одним ключом разделяют один fetch
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

Создаёт новую группу для дедупликации.

- `K` — тип ключа (extends `string`, по умолчанию `string`)
- `V` — тип значения (по умолчанию `unknown`)

Возвращает `CoflightGroup<K, V>`.

---

### `group.run(key, fn, options?)`

Выполняет `fn` для данного ключа, либо присоединяется к уже выполняющемуся вызову.

- **`key: K`** — ключ дедупликации.
- **`fn: (ctx: { signal: AbortSignal }) => Promise<V> | V`** — выполняемая функция. Вызывается только для **первого** вызова; все остальные разделяют тот же результат.
- **`options?`** — см. ниже.

Возвращает `Promise<V>`.

#### Опции

| Опция          | Тип           | Описание                                                                                        |
| -------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `signal`       | `AbortSignal` | Персональный сигнал отмены. **Не** отменяет общую операцию, пока **все** подписчики не отменят. |
| `timeout`      | `number`      | Персональный таймаут в мс. Реджектится с `TimeoutError` при превышении.                         |
| `ttl`          | `number`      | Кешировать результат N мс после завершения. Задаётся первым вызывающим.                         |
| `staleIfError` | `boolean`     | Если `true` и операция провалилась — вернуть последний успешный результат (если есть).          |

---

### `group.forget(key)`

Удаляет `key` из карты полётов, TTL-кеша и stale-хранилища. Уже подписанные вызывающие продолжают получать свой результат.

Возвращает `boolean` — `true`, если ключ был найден.

---

### `group.clear()`

Удаляет все записи (полёты, кеш, stale-результаты).

---

### `group.isRunning(key)`

Возвращает `boolean` — есть ли выполняющаяся операция для данного ключа.

---

### `group.stats()`

Возвращает `{ inflight: number; cached: number }`.

## Как это работает

```
Вызов A ─┐
Вызов B ─┼─→ run("user:42", fn) ─→ ОДИН вызов fn() ─→ результат
Вызов C ─┘                         │                      │
                                    └── все вызывающие ←───┘
                                        получают один результат
```

1. **Первый вызов** с ключом запускает реальную операцию.
2. **Последующие вызовы** с тем же ключом присоединяются к текущей операции.
3. Когда операция завершается, **все вызывающие получают результат**.
4. С `ttl` результат кешируется на заданный период — новая операция не запускается.
5. Каждый вызывающий может независимо отменить запрос через свой `AbortSignal`.
6. Общая операция отменяется только когда **все** вызывающие отменили запрос.

## Поведение отмены (Abort)

Каждый подписчик может передать свой `AbortSignal`. Когда подписчик отменяет запрос:

- Promise этого подписчика реджектится с `AbortError`.
- Другие подписчики **не затрагиваются**.
- Нижележащая операция продолжается, пока остаётся хотя бы один активный подписчик.
- Когда **все** подписчики отменили — общий `AbortSignal`, переданный в `fn`, тоже отменяется.

Все внутренние listener'ы используют `{ once: true }` для предотвращения утечек памяти.

## Примеры использования

### Дедупликация запросов к API

```typescript
import { createCoflight } from "@kdinisv/coflight";

const api = createCoflight<string, any>();

app.get("/users/:id", async (req, res) => {
  const user = await api.run(
    `user:${req.params.id}`,
    ({ signal }) => db.users.findById(req.params.id, { signal }),
    { timeout: 5000, ttl: 2000 },
  );
  res.json(user);
});
```

### SSR: дедупликация загрузки данных

```typescript
const loaders = createCoflight<string, PageData>();

async function renderPage(slug: string): Promise<string> {
  const data = await loaders.run(`page:${slug}`, () => fetchPageData(slug), {
    ttl: 10_000,
    staleIfError: true,
  });
  return template(data);
}
```

### Cron-задачи с защитой от наложения

```typescript
const jobs = createCoflight<string, void>();

// Даже если cron сработал дважды — работа выполнится один раз
cron.schedule("*/5 * * * *", () => {
  jobs.run("sync-orders", () => syncOrders());
});
```

### Отмена из WebSocket

```typescript
const flights = createCoflight<string, Report>();

ws.on("message", async (msg) => {
  const ac = new AbortController();
  ws.once("cancel", () => ac.abort());

  try {
    const report = await flights.run(
      `report:${msg.id}`,
      ({ signal }) => generateReport(msg.id, { signal }),
      { signal: ac.signal, timeout: 30_000 },
    );
    ws.send(JSON.stringify(report));
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    ws.send(JSON.stringify({ error: "failed" }));
  }
});
```

## Лицензия

MIT
