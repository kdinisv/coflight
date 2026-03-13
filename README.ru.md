# coflight

> Компактная TypeScript-библиотека для дедупликации параллельных async-вызовов по ключу.
> Один реальный запрос, множество ожидающих, ноль дублирующей работы.

[English](README.md) | **Русский**

## Проблема

Когда несколько частей приложения одновременно запрашивают один и тот же ресурс — тот же API-эндпоинт, запрос к БД или тяжёлое вычисление — каждый запрос запускает отдельную операцию. Это расходует ресурсы, увеличивает задержки и может вызвать **cache stampede** (лавинный перезапрос).

**coflight** объединяет параллельные вызовы по ключу: первый вызов запускает реальную работу, а все последующие с тем же ключом ждут и получают тот же результат.

### Почему не существующие пакеты?

| Пакет                                                                  | Проблема                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`inflight`](https://www.npmjs.com/package/inflight)                   | **Deprecated**, известные утечки памяти. 60M+ скачиваний в неделю как зомби-зависимость |
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
npm install coflight
```

## Быстрый старт

```typescript
import { createCoflight } from "coflight";

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

| Опция          | Тип           | Описание                                                                                                   |
| -------------- | ------------- | ---------------------------------------------------------------------------------------------------------- |
| `signal`       | `AbortSignal` | Персональный сигнал отмены подписчика. **Не** отменяет общую операцию, пока **все** подписчики не отменят. |
| `timeout`      | `number`      | Персональный таймаут в мс. Реджектится с `TimeoutError` при превышении.                                    |
| `ttl`          | `number`      | Кешировать результат на указанное количество мс после завершения. Задаётся первым вызывающим.              |
| `staleIfError` | `boolean`     | Если `true` и операция провалилась — вернуть последний успешный результат для этого ключа (если есть).     |

---

### `group.forget(key)`

Удаляет `key` из карты полётов, TTL-кеша и хранилища stale-результатов. Уже подписанные вызывающие продолжают получать свой результат.

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
                                        получают один
                                        результат
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
- Когда **все** подписчики отменили — общий `AbortSignal` (переданный в `fn`) тоже отменяется.

Все внутренние listener'ы используют `{ once: true }` для предотвращения утечек памяти — независимо от количества подписчиков.

## Примеры использования

### Дедупликация запросов к API

```typescript
import { createCoflight } from "coflight";

const api = createCoflight<string, any>();

// В обработчике HTTP-запроса (Express, Fastify и т.д.)
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

### Отмена из SSE / WebSocket

```typescript
const flights = createCoflight<string, Report>();

ws.on("message", async (msg) => {
  const ac = new AbortController();

  // Клиент может отменить запрос
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
