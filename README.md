# coflight

> Tiny TypeScript library for deduplicating concurrent async calls by key.
> One real request, many awaiters, zero duplicate work.

**English** | [Русский](#coflight-на-русском)

---

## The Problem

When multiple parts of your application simultaneously request the same resource, the same API endpoint, database query, or expensive computation, each request can trigger a separate operation. That wastes resources, increases latency, and can cause cache stampede.

**coflight** coalesces concurrent calls by key: the first caller starts the real work, and every later caller with the same key awaits the same result.

### Why not existing packages?

| Package                                                                | Problem                                                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`inflight`](https://www.npmjs.com/package/inflight)                   | **Deprecated**, known memory leaks, 60M+ weekly downloads as a zombie dependency |
| [`promise-inflight`](https://www.npmjs.com/package/promise-inflight)   | Last published 9 years ago, no tests                                             |
| [`node-singleflight`](https://www.npmjs.com/package/node-singleflight) | No timeout, memory leak risk with many listeners                                 |
| [`lru-cache`](https://www.npmjs.com/package/lru-cache)                 | Full cache engine, too heavy when all you need is dedup                          |

## Features

- **Zero dependencies**
- **First-class TypeScript** with full generic support
- **ESM + CJS** dual package
- **Per-subscriber `AbortSignal`** so one caller can cancel without affecting the others
- **Timeout** per subscriber
- **Short TTL cache** for reusing fresh results right after completion
- **`staleIfError`** to return the last successful result when the current operation fails
- **Node.js 18+**

## Roadmap

This roadmap shows the improvements users can expect in future releases.

Status legend: `[ ]` planned, `[x]` done. The version column shows the release where the item shipped; `TBD` means the target release is still open.

### Phase 1: Visibility and Control

| Status | Version | What will be added        | Why it matters                                                   |
| ------ | ------- | ------------------------- | ---------------------------------------------------------------- |
| [x]    | 0.2.0   | Better runtime stats      | Makes shared work and cache usage easier to understand.          |
| [x]    | 0.2.0   | Clearer result source     | Shows whether a result came from a shared request or from cache. |
| [x]    | 0.2.0   | Cache warm-up support     | Lets hot paths be prepared before real traffic arrives.          |
| [x]    | 0.2.0   | Safer stale-result limits | Keeps stale data useful without letting it grow out of control.  |

### Phase 2: Smarter Freshness

| Status | Version | What will be added                | Why it matters                                                    |
| ------ | ------- | --------------------------------- | ----------------------------------------------------------------- |
| [ ]    | TBD     | Background refresh for stale data | Keeps responses fast while data updates happen in the background. |
| [ ]    | TBD     | Safer shutdown behavior           | Makes service shutdown with active requests more predictable.     |
| [ ]    | TBD     | Easier monitoring integration     | Makes logs and metrics simpler to connect in real services.       |
| [ ]    | TBD     | More practical examples           | Reduces integration mistakes in real applications.                |

### Phase 3: Production Maturity

| Status | Version | What will be added           | Why it matters                                             |
| ------ | ------- | ---------------------------- | ---------------------------------------------------------- |
| [ ]    | TBD     | Performance benchmarks       | Sets realistic expectations about speed and tradeoffs.     |
| [ ]    | TBD     | Integration examples         | Shows how the library fits into common application stacks. |
| [ ]    | TBD     | Migration guides             | Makes it easier to move off older inflight-style packages. |
| [ ]    | TBD     | Helper APIs for common cases | Adds convenience for recurring usage patterns.             |

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

users.warm("user:42", { id: "42", name: "Warm cache" }, { ttl: 2_000 });

const detailed = await users.runDetailed("user:42", ({ signal }) =>
  fetch(`/api/users/42`, { signal }).then((r) => r.json()),
);

console.log(detailed.source); // "cache"
```

## API

### `createCoflight<K, V>(options?)`

Creates a new coalescing group.

- `K` — key type (extends `string`, default `string`)
- `V` — value type (default `unknown`)
- `options?.staleTtl` — max age for stale results in ms. Omit to keep stale results until replaced or forgotten. Set to `0` to disable stale retention.
- `options?.maxStaleEntries` — upper bound for retained stale results. Omit for no limit. Set to `0` to disable stale retention.

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

### `group.runDetailed(key, fn, options?)`

Same execution model as `group.run`, but returns both the value and its source.

Returns `Promise<{ value: V; source: "fresh" | "shared" | "cache" | "stale" }>`.

- `fresh` — this subscriber started the real work.
- `shared` — this subscriber joined an already running flight.
- `cache` — the result came from the TTL cache.
- `stale` — the real operation failed and `staleIfError` returned the last successful value.

---

### `group.warm(key, value, options?)`

Seed a key before traffic arrives.

- `value: V` — value to place into warm storage.
- `options?.ttl` — optional TTL cache window in ms.
- `options?.stale` — whether to also seed the stale store. Defaults to `true`.

Returns `boolean` — `true` if cache or stale storage was written. Returns `false` when the key is already in-flight or when nothing could be stored.

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

Returns live counts plus cumulative runtime counters:

```ts
{
  inflight: number;
  cached: number;
  stale: number;
  requests: number;
  freshRuns: number;
  sharedRuns: number;
  cacheHits: number;
  staleHits: number;
  warmups: number;
  aborts: number;
  timeouts: number;
}
```

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
4. With `ttl`, the result is cached for a short period, so no new operation runs.
5. Each caller can independently abort via their own `AbortSignal`.
6. Only when **all** callers have aborted is the shared operation cancelled.

## Abort Behaviour

Each subscriber can pass its own `AbortSignal`. When a subscriber aborts:

- That subscriber's promise rejects with `AbortError`.
- Other subscribers are **not affected**.
- The underlying operation continues as long as at least one subscriber remains.
- When **every** subscriber has aborted, the shared `AbortSignal` passed to `fn` is aborted too.

All internal listeners use `{ once: true }` to prevent memory leaks, no matter how many subscribers join.

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

// Even if cron fires twice, work runs once
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

Когда несколько частей приложения одновременно запрашивают один и тот же ресурс, один и тот же API-эндпоинт, запрос к БД или тяжёлое вычисление, каждый запрос может запускать отдельную операцию. Это расходует ресурсы, увеличивает задержки и может вызвать лавинный перезапрос.

**coflight** объединяет параллельные вызовы по ключу: первый вызов запускает реальную работу, а все последующие с тем же ключом ждут и получают тот же результат.

### Почему не существующие пакеты?

| Пакет                                                                  | Проблема                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`inflight`](https://www.npmjs.com/package/inflight)                   | **Deprecated**, известные утечки памяти, 60M+ скачиваний в неделю как зомби-зависимость |
| [`promise-inflight`](https://www.npmjs.com/package/promise-inflight)   | Последняя публикация 9 лет назад, тестов нет                                            |
| [`node-singleflight`](https://www.npmjs.com/package/node-singleflight) | Нет timeout, риск утечки памяти при большом числе listener'ов                           |
| [`lru-cache`](https://www.npmjs.com/package/lru-cache)                 | Полноценный кеш-движок, слишком тяжёлый, когда нужен только dedup                       |

## Возможности

- **Ноль зависимостей**
- **Полная поддержка TypeScript** с дженериками
- **ESM + CJS** — пакет публикуется в обоих форматах
- **Индивидуальный `AbortSignal` для каждого подписчика** — один вызывающий может отменить свой запрос, не затрагивая остальных
- **Таймаут** для каждого подписчика
- **Короткий TTL-кеш** — позволяет повторно использовать свежий результат сразу после завершения
- **`staleIfError`** — возвращает последний успешный результат, если текущая операция завершилась ошибкой
- **Node.js 18+**

## Дорожная карта

Обозначения статуса: `[ ]` запланировано, `[x]` сделано. В колонке версии указан релиз, в котором пункт вышел; `TBD` означает, что конкретная версия пока не назначена.

### Фаза 1: Наблюдаемость и контроль

| Статус | Версия | Что будет                      | Зачем это нужно                                                          |
| ------ | ------ | ------------------------------ | ------------------------------------------------------------------------ |
| [x]    | 0.2.0  | Более понятная статистика      | Показывает, как часто работа реально разделяется и как используется кеш. |
| [x]    | 0.2.0  | Понятный источник результата   | Показывает, пришёл ли результат из общего запроса или из кеша.           |
| [x]    | 0.2.0  | Поддержка прогрева кеша        | Позволяет заранее подготовить горячие пути до прихода нагрузки.          |
| [x]    | 0.2.0  | Безопасные лимиты stale-данных | Помогает держать устаревшие данные под контролем.                        |

### Фаза 2: Более умная свежесть

| Статус | Версия | Что будет                             | Зачем это нужно                                                     |
| ------ | ------ | ------------------------------------- | ------------------------------------------------------------------- |
| [ ]    | TBD    | Фоновое обновление stale-данных       | Позволяет быстро отвечать пользователю и обновлять данные в фоне.   |
| [ ]    | TBD    | Более безопасное завершение сервиса   | Делает остановку сервиса с активными запросами более предсказуемой. |
| [ ]    | TBD    | Более простое подключение мониторинга | Упрощает подключение логирования, метрик и внешнего мониторинга.    |
| [ ]    | TBD    | Больше практических примеров          | Снижает вероятность ошибок при интеграции.                          |

### Фаза 3: Production-зрелость

| Статус | Версия | Что будет                             | Зачем это нужно                                                  |
| ------ | ------ | ------------------------------------- | ---------------------------------------------------------------- |
| [ ]    | TBD    | Бенчмарки производительности          | Заранее задают реалистичные ожидания по скорости и компромиссам. |
| [ ]    | TBD    | Примеры интеграции                    | Показывают, как библиотека встраивается в типовые стеки.         |
| [ ]    | TBD    | Гайды по миграции                     | Упрощают переход со старых inflight-пакетов.                     |
| [ ]    | TBD    | Вспомогательные API для типовых задач | Добавляют удобство в частых сценариях использования.             |

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

users.warm("user:42", { id: "42", name: "Прогретый кеш" }, { ttl: 2_000 });

const detailed = await users.runDetailed("user:42", ({ signal }) =>
  fetch(`/api/users/42`, { signal }).then((r) => r.json()),
);

console.log(detailed.source); // "cache"
```

## API

### `createCoflight<K, V>(options?)`

Создаёт новую группу для дедупликации.

- `K` — тип ключа (extends `string`, по умолчанию `string`)
- `V` — тип значения (по умолчанию `unknown`)
- `options?.staleTtl` — максимальный возраст stale-результатов в мс. Если не указывать, stale-значения живут до замены или forget. Значение `0` отключает stale-хранилище.
- `options?.maxStaleEntries` — верхняя граница для количества stale-результатов. Если не указывать, лимита нет. Значение `0` отключает stale-хранилище.

Возвращает `CoflightGroup<K, V>`.

---

### `group.run(key, fn, options?)`

Выполняет `fn` для данного ключа или присоединяется к уже выполняющемуся вызову.

- **`key: K`** — ключ дедупликации.
- **`fn: (ctx: { signal: AbortSignal }) => Promise<V> | V`** — функция, которая будет выполнена. Вызывается только для **первого** запроса; последующие подписчики получают тот же результат.
- **`options?`** — см. ниже.

Возвращает `Promise<V>`.

#### Опции

| Опция          | Тип           | Описание                                                                                        |
| -------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `signal`       | `AbortSignal` | Персональный сигнал отмены. **Не** отменяет общую операцию, пока **все** подписчики не отменят. |
| `timeout`      | `number`      | Персональный таймаут в мс. Реджектится с `TimeoutError` при превышении.                         |
| `ttl`          | `number`      | Кешировать результат на указанное количество мс после завершения. Задаётся первым вызывающим.   |
| `staleIfError` | `boolean`     | Если `true` и операция провалилась, вернуть последний успешный результат для этого ключа.       |

---

### `group.runDetailed(key, fn, options?)`

Работает как `group.run`, но дополнительно возвращает источник результата.

Возвращает `Promise<{ value: V; source: "fresh" | "shared" | "cache" | "stale" }>`.

- `fresh` — этот подписчик запустил реальную работу.
- `shared` — этот подписчик присоединился к уже идущему полёту.
- `cache` — результат был взят из TTL-кеша.
- `stale` — реальная операция завершилась ошибкой, и `staleIfError` вернул последнее успешное значение.

---

### `group.warm(key, value, options?)`

Заранее заполняет ключ значением до прихода реального трафика.

- `value: V` — значение для прогрева.
- `options?.ttl` — окно TTL-кеша в мс.
- `options?.stale` — нужно ли одновременно прогреть stale-хранилище. По умолчанию `true`.

Возвращает `boolean` — `true`, если удалось записать кеш или stale-значение. Возвращает `false`, если ключ уже выполняется или сохранить было нечего.

---

### `group.forget(key)`

Удаляет `key` из карты полётов, TTL-кеша и хранилища stale-результатов. Уже подписанные вызывающие продолжают получать свой результат.

Возвращает `boolean` — `true`, если ключ был найден.

---

### `group.clear()`

Удаляет все записи: полёты, кеш и stale-результаты.

---

### `group.isRunning(key)`

Возвращает `boolean` — есть ли выполняющаяся операция для данного ключа.

---

### `group.stats()`

Возвращает живые размеры внутренних хранилищ и накопительные счётчики:

```ts
{
  inflight: number;
  cached: number;
  stale: number;
  requests: number;
  freshRuns: number;
  sharedRuns: number;
  cacheHits: number;
  staleHits: number;
  warmups: number;
  aborts: number;
  timeouts: number;
}
```

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
4. С `ttl` результат кешируется на короткий период, поэтому новая операция не запускается.
5. Каждый вызывающий может независимо отменить запрос через свой `AbortSignal`.
6. Общая операция отменяется только тогда, когда **все** вызывающие отменили запрос.

## Поведение отмены

Каждый подписчик может передать свой `AbortSignal`. Когда подписчик отменяет запрос:

- Promise этого подписчика реджектится с `AbortError`.
- Другие подписчики **не затрагиваются**.
- Нижележащая операция продолжается, пока остаётся хотя бы один активный подписчик.
- Когда **все** подписчики отменили запрос, общий `AbortSignal`, переданный в `fn`, тоже отменяется.

Все внутренние listener'ы используют `{ once: true }`, чтобы не накапливать лишние обработчики.

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

// Даже если cron сработал дважды, работа выполнится один раз
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
