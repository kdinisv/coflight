# coflight

> Tiny TypeScript library for deduplicating concurrent async calls by key.
> One real request, many awaiters, zero duplicate work.

**English** | [Русский](#coflight-на-русском)

---

## Install

```bash
npm install @kdinisv/coflight
```

## What It Does

Use coflight when several parts of your app can ask for the same resource at the same time:

- the first call starts the real work
- later calls with the same key wait for the same promise
- optional TTL lets you reuse the fresh result for a short window
- optional stale storage lets you fall back to the last successful value

Typical cases:

- API and database lookups
- SSR and server loaders
- expensive config or service-discovery fetches
- cron or worker overlap protection

## Quick Start

```ts
import { createCoflight } from "@kdinisv/coflight";

interface User {
  id: string;
  name: string;
}

const users = createCoflight<string, User>();

export async function getUser(id: string, signal?: AbortSignal): Promise<User> {
  return users.run(
    `user:${id}`,
    ({ signal }) => fetch(`/api/users/${id}`, { signal }).then((r) => r.json()),
    { signal, timeout: 3_000, ttl: 5_000 },
  );
}
```

## Result Sources

`runDetailed()` and `refreshDetailed()` return both the value and where it came from:

- `fresh` — this call started the real operation
- `shared` — this call joined an in-flight operation
- `cache` — the value came from the TTL cache
- `stale` — the value came from stale storage

## API

### `createCoflight<K, V>(options?)`

Creates an isolated coalescing group.

- `staleTtl?: number` — how long to keep stale values in ms. Omit to keep them until replaced or forgotten. Set `0` to disable stale storage.
- `maxStaleEntries?: number` — maximum number of stale entries to retain. Omit for no limit. Set `0` to disable stale storage.

```ts
const group = createCoflight<string, User>({
  staleTtl: 60_000,
  maxStaleEntries: 500,
});
```

### `group.run(key, fn, options?)`

Runs `fn` for `key`, or joins an existing in-flight call with the same key.

```ts
const value = await group.run(
  "user:42",
  ({ signal }) => loadUser("42", signal),
  {
    timeout: 2_000,
    ttl: 5_000,
  },
);
```

Options:

- `signal?: AbortSignal` — per-caller cancellation
- `timeout?: number` — per-caller timeout in ms
- `ttl?: number` — cache successful result for this many ms
- `staleIfError?: boolean` — return the last successful value if the fresh call fails
- `swr?: boolean` — return stale immediately and refresh in the background

### `group.runDetailed(key, fn, options?)`

Same behavior as `run`, but returns `{ value, source }`.

```ts
const result = await group.runDetailed("user:42", ({ signal }) =>
  loadUser("42", signal),
);

console.log(result.source);
```

### `group.warm(key, value, options?)`

Seeds a value before traffic arrives.

- `ttl?: number` — add the value to TTL cache
- `stale?: boolean` — also seed stale storage, defaults to `true`

```ts
group.warm("user:42", cachedUser, { ttl: 2_000 });
```

Returns `true` if something was stored.

### `group.refresh(key, fn, options?)`

Bypasses the TTL cache and forces a fresh execution. If the key is already running, the caller joins that in-flight work instead of starting a duplicate request.

```ts
await group.refresh("config:tenant-a", ({ signal }) =>
  loadConfig("tenant-a", signal),
);
```

### `group.refreshDetailed(key, fn, options?)`

Same as `refresh`, but returns `{ value, source }`.

### `group.forget(key)`

Removes one key from tracked state.

```ts
group.forget("user:42");
```

### `group.clear()`

Clears all tracked keys, cache entries, and stale values.

### `group.isRunning(key)`

Returns `true` while a key is in flight.

### `group.stats()`

Returns live counters and cumulative usage stats:

```ts
{
  inflight,
  cached,
  stale,
  requests,
  freshRuns,
  sharedRuns,
  cacheHits,
  staleHits,
  warmups,
  aborts,
  timeouts,
  swrHits,
  backgroundRefreshes,
  backgroundRefreshFailures,
}
```

### `group.drain()`

Stops accepting new work and waits for all in-flight operations, including SWR background refreshes, to finish.

Use this for graceful shutdown when you want existing work to complete.

### `group.shutdown()`

Aborts all in-flight operations and clears stored state immediately.

Use this when the process must stop now.

## Patterns

### TTL Cache

```ts
await group.run("article:home", fetchHomepage, { ttl: 10_000 });
```

Use when a short burst of repeated reads should reuse a fresh result.

### Stale On Error

```ts
await group.run("flags", loadFlags, { staleIfError: true });
```

Use when serving the last good value is better than failing the request.

### Stale While Revalidate

```ts
await group.run("service:billing", lookupService, { swr: true });
```

Use when fast responses matter more than always blocking on a refresh.

### Graceful Stop

```ts
await group.drain();
group.shutdown();
```

Use `drain()` if you want current work to finish. Use `shutdown()` if you need to abort it.

## Key Helpers

Available from both `@kdinisv/coflight` and `@kdinisv/coflight/keys`.

### `composeKey(...segments)`

Builds a key from one or more escaped segments.

```ts
import { composeKey } from "@kdinisv/coflight";

const key = composeKey("user", "tenant-a", "42");
```

### `createKeyFactory(prefix)`

Creates a reusable prefixed key builder.

```ts
import { createKeyFactory } from "@kdinisv/coflight/keys";

const userKey = createKeyFactory("user");

userKey("42");
userKey.scoped("tenant-a", "42");
```

### `createScopedKeyFactory(prefix, ...scopes)`

Creates a key builder with fixed runtime arity.

```ts
import { createScopedKeyFactory } from "@kdinisv/coflight/keys";

const configKey = createScopedKeyFactory("config", "tenantId", "env");

configKey("acme", "prod");
```

### `createKeyNamespace(schema)`

Creates a typed namespace of scoped key builders.

```ts
import { createKeyNamespace } from "@kdinisv/coflight/keys";

const keys = createKeyNamespace({
  user: ["tenantId", "userId"],
  session: ["sessionId"],
});

keys.user("acme", "42");
keys.session("sess-abc");
```

## Examples

See the full examples in:

- [examples/auth-scoped-fetch.ts](examples/auth-scoped-fetch.ts)
- [examples/multi-tenant-api.ts](examples/multi-tenant-api.ts)
- [examples/swr-service-lookup.ts](examples/swr-service-lookup.ts)
- [examples/graceful-shutdown.ts](examples/graceful-shutdown.ts)

## License

MIT

---

# coflight на русском

[English](#coflight) | **Русский**

> Компактная TypeScript-библиотека для дедупликации параллельных async-вызовов по ключу.
> Один реальный запрос, множество ожидающих, ноль дублирующей работы.

---

## Установка

```bash
npm install @kdinisv/coflight
```

## Что делает библиотека

Используйте coflight, когда несколько частей приложения могут одновременно запросить один и тот же ресурс:

- первый вызов запускает реальную работу
- следующие вызовы с тем же ключом ждут тот же promise
- опциональный TTL позволяет короткое время переиспользовать свежий результат
- опциональное stale-хранилище позволяет вернуть последнее успешное значение

Типичные сценарии:

- API и запросы к БД
- SSR и server loaders
- дорогие config- или service-discovery запросы
- защита от наложения cron и worker-задач

## Быстрый старт

```ts
import { createCoflight } from "@kdinisv/coflight";

interface User {
  id: string;
  name: string;
}

const users = createCoflight<string, User>();

export async function getUser(id: string, signal?: AbortSignal): Promise<User> {
  return users.run(
    `user:${id}`,
    ({ signal }) => fetch(`/api/users/${id}`, { signal }).then((r) => r.json()),
    { signal, timeout: 3_000, ttl: 5_000 },
  );
}
```

## Источник результата

`runDetailed()` и `refreshDetailed()` возвращают не только значение, но и источник:

- `fresh` — этот вызов действительно запустил работу
- `shared` — этот вызов присоединился к уже выполняющейся операции
- `cache` — значение пришло из TTL-кеша
- `stale` — значение пришло из stale-хранилища

## API

### `createCoflight<K, V>(options?)`

Создаёт изолированную группу дедупликации.

- `staleTtl?: number` — сколько хранить stale-значения в мс. Если не указывать, они живут до замены или `forget`. Значение `0` отключает stale-хранилище.
- `maxStaleEntries?: number` — максимум stale-записей. Если не указывать, лимита нет. Значение `0` отключает stale-хранилище.

```ts
const group = createCoflight<string, User>({
  staleTtl: 60_000,
  maxStaleEntries: 500,
});
```

### `group.run(key, fn, options?)`

Запускает `fn` для `key` или присоединяет вызов к уже идущей операции с тем же ключом.

```ts
const value = await group.run(
  "user:42",
  ({ signal }) => loadUser("42", signal),
  {
    timeout: 2_000,
    ttl: 5_000,
  },
);
```

Опции:

- `signal?: AbortSignal` — отмена только для конкретного вызова
- `timeout?: number` — timeout для конкретного вызова в мс
- `ttl?: number` — кешировать успешный результат на это число миллисекунд
- `staleIfError?: boolean` — вернуть последнее успешное значение, если свежий вызов завершился ошибкой
- `swr?: boolean` — сразу вернуть stale и обновить значение в фоне

### `group.runDetailed(key, fn, options?)`

То же поведение, что и у `run`, но возвращает `{ value, source }`.

```ts
const result = await group.runDetailed("user:42", ({ signal }) =>
  loadUser("42", signal),
);

console.log(result.source);
```

### `group.warm(key, value, options?)`

Прогревает значение до прихода трафика.

- `ttl?: number` — положить значение в TTL-кеш
- `stale?: boolean` — также положить в stale-хранилище, по умолчанию `true`

```ts
group.warm("user:42", cachedUser, { ttl: 2_000 });
```

Возвращает `true`, если данные были записаны.

### `group.refresh(key, fn, options?)`

Игнорирует TTL-кеш и принудительно запускает свежее выполнение. Если операция уже идёт, вызов присоединяется к ней, а не создаёт дубликат.

```ts
await group.refresh("config:tenant-a", ({ signal }) =>
  loadConfig("tenant-a", signal),
);
```

### `group.refreshDetailed(key, fn, options?)`

То же, что и `refresh`, но возвращает `{ value, source }`.

### `group.forget(key)`

Удаляет один ключ из отслеживаемого состояния.

```ts
group.forget("user:42");
```

### `group.clear()`

Очищает все ключи, кеш и stale-значения.

### `group.isRunning(key)`

Возвращает `true`, если операция по ключу сейчас выполняется.

### `group.stats()`

Возвращает текущие счётчики и накопленную статистику:

```ts
{
  inflight,
  cached,
  stale,
  requests,
  freshRuns,
  sharedRuns,
  cacheHits,
  staleHits,
  warmups,
  aborts,
  timeouts,
  swrHits,
  backgroundRefreshes,
  backgroundRefreshFailures,
}
```

### `group.drain()`

Перестаёт принимать новую работу и ждёт завершения всех текущих операций, включая фоновые SWR-обновления.

Используйте для graceful shutdown, когда нужно дать текущей работе завершиться.

### `group.shutdown()`

Сразу прерывает все активные операции и очищает сохранённое состояние.

Используйте, когда процесс нужно остановить немедленно.

## Паттерны

### TTL-кеш

```ts
await group.run("article:home", fetchHomepage, { ttl: 10_000 });
```

Подходит, когда серия повторных чтений должна короткое время использовать свежий результат.

### Stale при ошибке

```ts
await group.run("flags", loadFlags, { staleIfError: true });
```

Подходит, когда лучше отдать последнее корректное значение, чем завалить запрос.

### Stale While Revalidate

```ts
await group.run("service:billing", lookupService, { swr: true });
```

Подходит, когда важнее быстрый ответ, чем ожидание обновления на каждом запросе.

### Аккуратная остановка

```ts
await group.drain();
group.shutdown();
```

Используйте `drain()`, если текущая работа должна завершиться. Используйте `shutdown()`, если её нужно прервать.

## Helper'ы для ключей

Доступны из `@kdinisv/coflight` и `@kdinisv/coflight/keys`.

### `composeKey(...segments)`

Собирает ключ из одного или нескольких сегментов с автоматическим экранированием.

```ts
import { composeKey } from "@kdinisv/coflight";

const key = composeKey("user", "tenant-a", "42");
```

### `createKeyFactory(prefix)`

Создаёт переиспользуемый билдер ключей с фиксированным префиксом.

```ts
import { createKeyFactory } from "@kdinisv/coflight/keys";

const userKey = createKeyFactory("user");

userKey("42");
userKey.scoped("tenant-a", "42");
```

### `createScopedKeyFactory(prefix, ...scopes)`

Создаёт билдер ключей с фиксированной runtime-арностью.

```ts
import { createScopedKeyFactory } from "@kdinisv/coflight/keys";

const configKey = createScopedKeyFactory("config", "tenantId", "env");

configKey("acme", "prod");
```

### `createKeyNamespace(schema)`

Создаёт типизированное пространство имён с builder'ами ключей.

```ts
import { createKeyNamespace } from "@kdinisv/coflight/keys";

const keys = createKeyNamespace({
  user: ["tenantId", "userId"],
  session: ["sessionId"],
});

keys.user("acme", "42");
keys.session("sess-abc");
```

## Примеры

Полные примеры есть в:

- [examples/auth-scoped-fetch.ts](examples/auth-scoped-fetch.ts)
- [examples/multi-tenant-api.ts](examples/multi-tenant-api.ts)
- [examples/swr-service-lookup.ts](examples/swr-service-lookup.ts)
- [examples/graceful-shutdown.ts](examples/graceful-shutdown.ts)

## Лицензия

MIT
