# Remora Foundation Implementation Plan (план 1 из 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Каркас сервиса remora: монорепозиторий на Node.js/TypeScript, полная схема PostgreSQL из спецификации с проверкой ограничений, механизм плагинов с базовым плагином шкал времени, сервисы сущностей и словарей.

**Architecture:** npm workspaces: `@remora/sdk` (типы плагинов, ошибки), `@remora/core-plugin` (декларативные шкалы времени), `@remora/server` (БД, миграции, загрузчик плагинов, сервисы). Сервисы — функции над `Queryable` (пул или клиент транзакции), чтобы операции пакета `apply` (план 2) выполнялись в одной транзакции. Тесты идут против настоящего PostgreSQL 18 в контейнере (testcontainers).

**Tech Stack:** Node.js 24, TypeScript (strict, ESM, NodeNext), npm workspaces, vitest, `pg`, `ajv`, `@testcontainers/postgresql`, образ `postgres:18`.

**Spec:** `docs/superpowers/specs/2026-10-22-historicity-design.md` (разделы 3–7, 11–13 для схемы; 4, 5, 9, 13 для кода этого плана).

## Дорожная карта

Спецификация разбита на четыре плана; каждый даёт работающий, тестируемый результат.

1. **Foundation (этот план):** каркас, схема БД, плагины и шкалы, сущности, словари.
2. **Факты:** `apply` (пакеты, ссылки `as`/`$имя`, ошибки), свойства, связи, отзыв, чтение `property_at`/`property_history`/`relation_history`.
3. **Обходы, события, evidence:** `neighbors`, события и поиск, источники evidence (ingest, retention), `apply_retention`.
4. **Транспорт и служебное:** HTTP, MCP, секретный URL, JSON Schema контракта, служебный API (`add_plugin`, удаление плагина — для `remora-core` отказ с `invalid_plugin`, `purge_evidence`, `pin_evidence`), Docker.

## Global Constraints

Каждая задача неявно включает этот раздел.

- Node.js 24, TypeScript `strict`, ESM, `module`/`moduleResolution`: `NodeNext`; в относительных импортах расширение `.js`.
- PostgreSQL 18, расширения `btree_gist` и `pg_trgm`. Внутренние ссылки `bigint`; идентификаторы словарей `smallint`; текст только в `entity.key`.
- Нормализация имени типа (спецификация, раздел 9): «нижний регистр, пробелы в `_`, без спецсимволов». Имена не совпадают между словарями `relation_type` и `property_type`.
- Время: полуинтервал `[from, to)`, обе границы опциональны (`NULL` = без ограничения); безвременной факт — `time_axis` и `time_span` оба `NULL`.
- `encode` шкалы времени возвращает `bigint`; кодирование сохраняет порядок.
- `limit` в поисках: по умолчанию 50, максимум 200; ответ поиска `{rows, total, truncated}`.
- Поиск без оценок сходства: слова запроса ищутся по вхождению (`ILIKE`), триграммные индексы только ускоряют.
- Ошибки — `RemoraError` с кодом из спецификации (раздел 10.1) плюс `invalid_name`, `invalid_param`, `invalid_plugin`, `invalid_config` (добавляются в список кодов спецификации в задаче 1).
- Тексты для LLM (описания шкал и типов) пишутся по-русски; идентификаторы в коде по-английски.
- Плагин `remora-core` неотключаемый: он всегда регистрируется при старте, его нельзя удалить или отключить, а при ошибке его загрузки сервис не стартует (в отличие от остальных плагинов, которые деградируют).

## Review Focus

Входы, которые спецификация подразумевает, но не описывает; у каждого есть тест в задаче-владельце.

1. Символы `%` и `_` в запросе поиска не должны работать как маски (`findEntities`, поиск типов) — задачи 6, 7.
2. Имена типов на кириллице нормализуются, а не стираются целиком (`«Любимый цвет»` → `любимый_цвет`); пустое после нормализации имя — ошибка `invalid_name` — задача 7.
3. Одновременное создание одной сущности или типа двумя клиентами не даёт «дубликат»-ошибки наружу: сущность идемпотентна, тип возвращает `name_taken` — задачи 6, 7.
4. Граничные значения шкалы `packed` (максимум компонента, максимум+1, отрицательное, дробное, строка) и значения за пределами 2^53 в `bigint` — задача 4.
5. Плагин с падающим `setup` или неверной конфигурацией не останавливает старт (деградация), а два плагина с одним именем шкалы и сбой `remora-core` останавливают — задача 5.

## File Structure

```
package.json                          # workspaces, скрипты
tsconfig.base.json
vitest.config.ts                      # проекты: unit, server
.gitignore
packages/sdk/                         # @remora/sdk
  src/errors.ts                       # RemoraError, ErrorCode
  src/plugin.ts                       # типы плагина, definePlugin
  src/index.ts
  test/sdk.test.ts
packages/core-plugin/                 # @remora/core-plugin
  src/config.ts                       # JSON Schema конфигурации, defaultConfig
  src/axes.ts                         # integer / datetime / packed
  src/index.ts                        # default export — плагин
  test/axes.test.ts
packages/server/                      # @remora/server
  migrations/001_init.sql
  src/db/types.ts                     # Queryable
  src/db/migrate.ts                   # runMigrations
  src/sql/like.ts                     # escapeLike, wordPatterns, clampLimit
  src/plugins/registry.ts             # loadPlugins, PluginRegistry, addPlugin
  src/services/entities.ts
  src/services/dictionaries.ts
  src/app.ts                          # startRemora
  src/index.ts
  test/globalSetup.ts                 # контейнер PostgreSQL
  test/helpers/testDb.ts              # createTestDb, seedBasics
  test/{migrate,schema,registry,entities,dictionaries,app}.test.ts
```

---

### Task 1: Каркас монорепозитория и `@remora/sdk`

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`, `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, `packages/sdk/src/{errors,plugin,index}.ts`, `packages/sdk/test/sdk.test.ts`
- Modify: `docs/superpowers/specs/2026-10-22-historicity-design.md` (список кодов ошибок, раздел 10.1)

**Interfaces:**
- Produces (`@remora/sdk`):
  - `type ErrorCode` — коды из спецификации: `unknown_entity`, `unknown_type`, `unknown_axis`, `unknown_ref`, `value_type_mismatch`, `single_valued_conflict`, `timeless_conflict`, `invalid_time`, `not_found`, `name_taken`, `invalid_payload`, `unknown_source`, `too_many_paths`, `concurrent_update`, `axis_unavailable`, `source_unavailable` и новые `invalid_name`, `invalid_param`, `invalid_plugin`, `invalid_config`.
  - `class RemoraError extends Error { constructor(code: ErrorCode, message: string, details?: Record<string, unknown>); readonly code: ErrorCode; readonly details?: Record<string, unknown>; toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } }`
  - `type JsonSchema = Record<string, unknown>`
  - `interface TimeAxisDef { name: string; description: string; valueSchema: JsonSchema; example: unknown; encode(value: unknown): bigint; decode(n: bigint): unknown }`
  - `interface RetentionRow { id: bigint; payload: unknown; retentionState: unknown; createdAt: Date }`
  - `type RetentionAction = { id: bigint; action: 'keep' } | { id: bigint; action: 'replace'; payload: unknown; retentionState: unknown } | { id: bigint; action: 'purge' }`
  - `interface EvidenceSourceDef { name: string; description: string; payloadSchema: JsonSchema; ingest(payload: unknown): { payload: unknown; retentionState?: unknown }; planRetention(rows: RetentionRow[], now: Date): RetentionAction[] }`
  - `interface PluginDef<C = unknown> { name: string; configSchema: JsonSchema; defaultConfig: C; setup(config: C): { timeAxes?: TimeAxisDef[]; evidenceSources?: EvidenceSourceDef[] } }`
  - `function definePlugin<C>(def: PluginDef<C>): PluginDef<C>` — возвращает переданный объект.

- [ ] **Step 1: Создать каркас.** Корневой `package.json` (`"private": true`, `"type": "module"`, `"workspaces": ["packages/*"]`, скрипты `test` = `vitest run`, `typecheck` = `tsc -p packages/sdk --noEmit` и аналогично для остальных пакетов), `tsconfig.base.json` (strict, NodeNext, ES2023, `noEmit`), `.gitignore` (`node_modules`, `dist`). Пакет `@remora/sdk`: `"exports": {".": "./src/index.ts"}`. Dev-зависимости в корне: `vitest`, `typescript`, `@types/node`. `vitest.config.ts` с проектами `unit` (`packages/sdk/test/**`, `packages/core-plugin/test/**`) и `server` (`packages/server/test/**`, `globalSetup: ['packages/server/test/globalSetup.ts']` — файл появится в задаче 2; до этого в конфиге проекта `server` не указывать `globalSetup`).
- [ ] **Step 2: Написать падающий тест** `packages/sdk/test/sdk.test.ts`:

```ts
it('RemoraError carries code, message and details and serializes', () => {
  const e = new RemoraError('unknown_entity', 'нет такой сущности', { key: 'bob' });
  expect(e).toBeInstanceOf(Error);
  expect(e.toJSON()).toEqual({ code: 'unknown_entity', message: 'нет такой сущности', details: { key: 'bob' } });
});
it('RemoraError.toJSON omits details when absent', () => {
  expect(new RemoraError('not_found', 'x').toJSON()).toEqual({ code: 'not_found', message: 'x' });
});
it('definePlugin returns the same definition object', () => {
  const def = { name: 'p', configSchema: {}, defaultConfig: {}, setup: () => ({}) };
  expect(definePlugin(def)).toBe(def);
});
```

- [ ] **Step 3: Запустить** `npm install && npx vitest run --project unit` — ожидается FAIL (модуль не определён).
- [ ] **Step 4: Реализовать** `errors.ts`, `plugin.ts`, `index.ts` по блоку Interfaces.
- [ ] **Step 5: Добавить новые коды** (`invalid_name`, `invalid_param`, `invalid_plugin`, `invalid_config`) в список кодов раздела 10.1 спецификации.
- [ ] **Step 6: Запустить** `npx vitest run --project unit` — PASS; `npm run typecheck` без ошибок.
- [ ] **Step 7: Commit** (`package.json package-lock.json tsconfig.base.json vitest.config.ts .gitignore packages/sdk docs/superpowers/specs/2026-10-22-historicity-design.md`): `feat: monorepo scaffold and @remora/sdk`.

---

### Task 2: Тестовая БД и запуск миграций

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/src/db/{types,migrate}.ts`, `packages/server/src/index.ts`, `packages/server/test/globalSetup.ts`, `packages/server/test/helpers/testDb.ts`, `packages/server/test/migrate.test.ts`, `packages/server/migrations/001_init.sql` (пока содержит только `CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pg_trgm;`)
- Modify: `vitest.config.ts` (подключить `globalSetup` проекту `server`)

**Interfaces:**
- Produces:
  - `interface Queryable { query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> }` (`db/types.ts`; типы из `pg`)
  - `runMigrations(pool: Pool, dir?: string): Promise<string[]>` — применяет файлы `*.sql` каталога (по умолчанию `packages/server/migrations`) в порядке имён, каждый в своей транзакции; ведёт таблицу `schema_migration(name text primary key, applied_at timestamptz)`; возвращает имена применённых в этом вызове файлов.
  - `createTestDb(): Promise<{ pool: Pool; url: string; drop(): Promise<void> }>` — свежая база в контейнере из `globalSetup` (`CREATE DATABASE test_<случайное>`), миграции не запускает.
  - Зависимости сервера: `pg`, `@types/pg`, `ajv`; dev: `@testcontainers/postgresql`.

- [ ] **Step 1: Написать падающий тест** `migrate.test.ts`:

```ts
it('applies migrations once and records them', async () => {
  const { pool, drop } = await createTestDb();
  expect(await runMigrations(pool)).toEqual(['001_init.sql']);
  expect(await runMigrations(pool)).toEqual([]);
  const { rows } = await pool.query('SELECT name FROM schema_migration');
  expect(rows).toEqual([{ name: '001_init.sql' }]);
  await drop();
});
it('rolls back a failing migration and keeps earlier ones', async () => {
  // каталог из fixtures: 001_ok.sql, 002_bad.sql (синтаксическая ошибка)
  await expect(runMigrations(pool, fixtureDir)).rejects.toThrow();
  const { rows } = await pool.query('SELECT name FROM schema_migration');
  expect(rows).toEqual([{ name: '001_ok.sql' }]);
});
```

Файлы фикстур: `packages/server/test/fixtures/migrations-bad/{001_ok.sql,002_bad.sql}`.
- [ ] **Step 2: Запустить** `npx vitest run --project server packages/server/test/migrate.test.ts` — FAIL.
- [ ] **Step 3: Реализовать** `globalSetup.ts` (запуск `PostgreSqlContainer('postgres:18')`, `project.provide('pgAdminUrl', url)`, остановка в teardown), `testDb.ts`, `migrate.ts`.
- [ ] **Step 4: Запустить** тот же тест — PASS (Docker должен быть запущен).
- [ ] **Step 5: Commit** (`packages/server vitest.config.ts package-lock.json`): `feat: test database harness and migration runner`.

---

### Task 3: Схема БД и проверка ограничений

**Files:**
- Modify: `packages/server/migrations/001_init.sql`
- Create: `packages/server/test/helpers/seed.ts`, `packages/server/test/schema.test.ts`

**Interfaces:**
- Consumes: `createTestDb`, `runMigrations` (задача 2).
- Produces:
  - Все таблицы спецификации: `entity`, `relation_type`, `property_type`, `plugin`, `time_axis`, `evidence_source`, `evidence_log`, `property_version` (триггер `property_version_fill_t`, условный EXCLUDE, составной FK), `relation`, `event`, `event_time`, `event_entity`, индексы и GIN-индексы `pg_trgm`.
  - `seedBasics(db: Queryable): Promise<{ bobId: bigint; axes: { gameDay: number; real: number }; types: { jobTitle: number; nickname: number; height: number } }>` — строка `plugin('test','test','{}')`, шкалы `game_day`, `real` (поля `description`, `value_schema`, `example` непустые), типы `job_title` (одноместный), `nickname` (многоместный), `height` (одноместный), сущность `bob`.

- [ ] **Step 1: Написать падающие тесты** `schema.test.ts` (в каждом тесте: `createTestDb` + `runMigrations` + `seedBasics`). Вспомогательная `insertProp(db, {entity, type, axis?, span?, value, retracted?})` вставляет строку `property_version` (флаг `single_valued` не передаётся, его ставит триггер). Тесты (значения — из спайка и спецификации):

| Тест | Действия | Ожидание |
|---|---|---|
| trigger fills single_valued | вставить `job_title` | `single_valued = true`; для `nickname` — `false` |
| overlap on one axis rejected | `job_title` `[292,)`, затем `[300,)` на той же шкале | ошибка с кодом PostgreSQL `23P01` |
| other axis allowed | тот же интервал на шкале `real` | успех |
| close then insert | `UPDATE` первой строки на `[292,300)`, вставка `[300,)` в одной транзакции | успех |
| timeless duplicate rejected | две безвременных `height` | `23P01` |
| timeless and timed do not collide in DB | безвременная и временная `height` | успех (запрет — на уровне API, план 2) |
| multi-valued overlap allowed | два открытых `nickname` `[292,)`, `[295,)` | успех |
| retracted row does not block | отозвать (`retracted_at = now()`) `[292,)`, вставить `[292,)` | успех (закрывает открытый вопрос 2 спецификации) |
| axis without span rejected | `time_axis` задан, `time_span` `NULL` | `23514` (CHECK) |
| single_valued flag cannot change under rows | после вставки `job_title` обновить `property_type.single_valued` | `23503` (составной FK) |
| bad evidence_id rejected | `evidence_id = 999` | `23503` |
| relation: axis without span rejected | вставка в `relation` | `23514` |
| event_time instant must be [t,t+1) | `instant = true`, `time_span = [5,7)` | `23514`; `[5,6)` — успех |
| event_entity role defaults | вставка без `role` | `role = 'participant'` |
| event_entity PK allows two roles | один участник с ролями `actor`, `witness` | успех; повтор той же пары — `23505` |

- [ ] **Step 2: Запустить** `npx vitest run --project server packages/server/test/schema.test.ts` — FAIL (таблиц нет).
- [ ] **Step 3: Реализовать** `001_init.sql`: DDL берётся из спецификации (разделы 3–7, 11, 12, 13) дословно, порядок создания — `plugin`, словари, `entity`, `time_axis`, `evidence_source`, `evidence_log`, `property_version`, `relation`, `event`, `event_time`, `event_entity`. Единственное добавление к спецификации — CHECK в `event_time`: `(NOT instant) OR (lower(time_span) IS NOT NULL AND upper(time_span) = lower(time_span) + 1)`; в задаче 3 добавить это же правило в раздел 11 спецификации одним предложением.
- [ ] **Step 4: Запустить** тот же файл — PASS.
- [ ] **Step 5: Commit** (`packages/server docs/superpowers/specs/2026-10-22-historicity-design.md`): `feat: database schema with constraint tests`.

---

### Task 4: Базовый плагин `@remora/core-plugin` (шкалы времени)

**Files:**
- Create: `packages/core-plugin/package.json` (`"exports": {".": "./src/index.ts"}`, зависимость `@remora/sdk`), `packages/core-plugin/tsconfig.json`, `packages/core-plugin/src/{config,axes,index}.ts`, `packages/core-plugin/test/axes.test.ts`

**Interfaces:**
- Consumes: `definePlugin`, `TimeAxisDef`, `RemoraError` (`@remora/sdk`).
- Produces:
  - `default` export — `PluginDef<CoreConfig>` с `name: 'remora-core'`, `configSchema` (JSON Schema: объект с обязательным массивом `timeAxes`, `additionalProperties: false`), `defaultConfig` — шкалы `game_day` (`integer`), `real` (`datetime`, `unit: 'seconds'`), `story` (`packed`, компоненты `tome`, `chapter`, `scene`, у каждого `max: 999`).
  - `type AxisConfig = { name: string; description?: string } & ({ kind: 'integer' } | { kind: 'datetime'; unit: 'seconds' | 'milliseconds' } | { kind: 'packed'; components: { name: string; max: number }[] })`
  - `buildAxis(cfg: AxisConfig): TimeAxisDef` (`axes.ts`).
  - Правила: `integer` — `encode` принимает целое `number`, `decode` возвращает `number`; `datetime` — `encode` принимает строку ISO-8601 с часовым поясом (`Z` или смещение), результат — секунды (или миллисекунды) от epoch, `decode` возвращает ISO-строку в UTC; `packed` — значение объект `{tome, chapter?, scene?}` (обязателен только первый компонент, остальные по умолчанию 0), основание компонента `max + 1`, `encode` = свёртка по основаниям (старший компонент первым); `valueSchema` у `packed` — объект с `required: [первый компонент]`, `example` — `{tome: 10, chapter: 5}` для `story` по умолчанию (для произвольной конфигурации — первые два компонента со значениями 1). Любое неверное значение — `RemoraError('invalid_time', …, { axis, reason })`.

- [ ] **Step 1: Написать падающие тесты** `axes.test.ts` (значения точные):

```ts
const story = buildAxis({ name: 'story', kind: 'packed', components: [
  { name: 'tome', max: 999 }, { name: 'chapter', max: 999 }, { name: 'scene', max: 999 }] });
it('packs components by radix max+1', () => {
  expect(story.encode({ tome: 2, chapter: 3, scene: 1 })).toBe(2_003_001n);
  expect(story.encode({ tome: 2 })).toBe(2_000_000n);
});
it('preserves order', () => {
  expect(story.encode({ tome: 2, chapter: 999, scene: 999 })).toBeLessThan(story.encode({ tome: 3 }));
});
it('rejects out-of-range components (no collision (2,1000,0) vs (3,0,0))', () => {
  expect(() => story.encode({ tome: 2, chapter: 1000 })).toThrow(expect.objectContaining({ code: 'invalid_time' }));
  for (const bad of [{ tome: -1 }, { tome: 1.5 }, { tome: '1' }, {}, null, 'x'])
    expect(() => story.encode(bad)).toThrow(expect.objectContaining({ code: 'invalid_time' }));
});
it('round-trips', () => {
  expect(story.decode(story.encode({ tome: 10, chapter: 5, scene: 0 }))).toEqual({ tome: 10, chapter: 5, scene: 0 });
});
it('datetime seconds', () => {
  const real = buildAxis({ name: 'real', kind: 'datetime', unit: 'seconds' });
  expect(real.encode('2026-10-01T00:00:00Z')).toBe(1_790_812_800n);
  expect(real.encode('2026-10-01T03:00:00+03:00')).toBe(1_790_812_800n);
  expect(real.decode(1_790_812_800n)).toBe('2026-10-01T00:00:00.000Z');
  expect(() => real.encode('2026-10-01')).toThrow(expect.objectContaining({ code: 'invalid_time' }));
});
it('integer axis', () => {
  const day = buildAxis({ name: 'game_day', kind: 'integer' });
  expect(day.encode(292)).toBe(292n);
  expect(() => day.encode(1.5)).toThrow(expect.objectContaining({ code: 'invalid_time' }));
});
it('packed with huge radix stays exact beyond 2^53', () => {
  const big = buildAxis({ name: 'big', kind: 'packed', components: [{ name: 'a', max: 999_999_999 }, { name: 'b', max: 999_999_999 }] });
  expect(big.decode(big.encode({ a: 9_007_199, b: 254_740_993 }))).toEqual({ a: 9_007_199, b: 254_740_993 });
});
it('default plugin config builds story/game_day/real with non-empty description, schema and example', () => {
  const axes = plugin.setup(plugin.defaultConfig).timeAxes!;
  expect(axes.map(a => a.name)).toEqual(['game_day', 'real', 'story']);
  for (const a of axes) { expect(a.description.length).toBeGreaterThan(10); expect(a.example).toBeDefined(); }
  expect(axes[2].example).toEqual({ tome: 10, chapter: 5 });
});
```

- [ ] **Step 2: Запустить** `npx vitest run --project unit packages/core-plugin` — FAIL.
- [ ] **Step 3: Реализовать** `buildAxis` (вычисления на `BigInt`, чтобы не терять точность), `config.ts`, `index.ts`. Описания по умолчанию — русские строки-константы (для `packed`: перечисляют компоненты и правило «старший компонент первым»).
- [ ] **Step 4: Запустить** — PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** (`packages/core-plugin package-lock.json`): `feat: remora-core plugin with integer, datetime and packed time axes`.

---

### Task 5: Загрузчик плагинов и реестр

**Files:**
- Create: `packages/server/src/plugins/registry.ts`, `packages/server/test/registry.test.ts`

**Interfaces:**
- Consumes: `PluginDef`, `TimeAxisDef`, `EvidenceSourceDef`, `RemoraError` (`@remora/sdk`); `Queryable`; таблицы `plugin`, `time_axis`, `evidence_source` (задача 3).
- Produces:
  - `type Importer = (spec: string) => Promise<unknown>` — возвращает default export модуля (определение плагина); по умолчанию `async spec => (await import(spec)).default`. Реальная загрузка пакета по пути проверяется в плане 4 (Docker); в тестах `Importer` подменяется.
  - `interface Logger { warn(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void }`
  - `addPlugin(db: Queryable, args: { package: string }, importer?: Importer): Promise<{ id: number; name: string }>` — загружает пакет, проверяет форму определения и `defaultConfig` по `configSchema` (Ajv), вставляет строку `plugin(name, package, config = defaultConfig)`. Ошибки: `invalid_plugin` (нет `name`/`setup`/`configSchema`), `invalid_config`, `name_taken` (плагин с таким именем уже есть).
  - `CORE_PLUGIN_NAME = 'remora-core'` — имя неотключаемого плагина.
  - `loadPlugins(db: Queryable, opts?: { importer?: Importer; logger?: Logger }): Promise<PluginRegistry>` — для каждой строки `plugin` загружает пакет, валидирует `config`, вызывает `setup(config)`, делает upsert шкал и источников (описание, схема и пример копируются в строки; `plugin_id` проставляется). Плагин, не загрузившийся, с неверной конфигурацией или упавшим `setup`, помечается недоступным и логируется через `logger.error`; остальные работают. Исключение — `remora-core`: его сбой бросает исключение (`invalid_plugin`), старт останавливается. Имя шкалы или источника, уже принадлежащее другому плагину, — исключение `name_taken` (старт останавливается).
  - `interface PluginRegistry { getAxis(name: string): { id: number; def: TimeAxisDef }; status(): { name: string; ok: boolean; error?: string }[] }` — для неизвестной шкалы `unknown_axis`; для шкалы недоступного плагина `axis_unavailable` (имя шкалы определяется по строкам `time_axis` в БД).

- [ ] **Step 1: Написать падающие тесты** `registry.test.ts` (фиктивные плагины через `definePlugin`, `Importer` — `async spec => fakes[spec]`):

```ts
it('addPlugin stores name and default config', async () => {
  const r = await addPlugin(pool, { package: 'fake-a' }, importer);
  const { rows } = await pool.query('SELECT name, package, config FROM plugin');
  expect(rows).toEqual([{ name: 'fake-a', package: 'fake-a', config: { n: 1 } }]);
});
it('addPlugin rejects a duplicate name', ... code 'name_taken');
it('addPlugin rejects an invalid defaultConfig', ... code 'invalid_config');
it('addPlugin rejects a definition without setup', ... code 'invalid_plugin');
it('loadPlugins registers axes and copies description/schema/example into time_axis', async () => {
  const reg = await loadPlugins(pool, { importer });
  const { rows } = await pool.query('SELECT name, description, value_schema, example FROM time_axis');
  expect(rows).toEqual([{ name: 'day', description: 'День игры', value_schema: { type: 'integer' }, example: 3 }]);
  expect(reg.getAxis('day').def.encode(5)).toBe(5n);
});
it('loadPlugins is idempotent and updates the description on restart', ...);
it('a plugin whose setup throws is unavailable; others keep working; error is logged', async () => {
  const reg = await loadPlugins(pool, { importer, logger });
  expect(reg.status()).toEqual([{ name: 'good', ok: true }, { name: 'bad', ok: false, error: expect.stringContaining('boom') }]);
  expect(logger.error).toHaveBeenCalled();
  expect(() => reg.getAxis('bad_axis')).toThrow(expect.objectContaining({ code: 'axis_unavailable' }));  // шкала bad_axis осталась в БД с прошлого запуска
});
it('a plugin with invalid stored config is unavailable', ... status ok:false);
it('a failing remora-core aborts startup instead of degrading', async () => {
  // строка plugin 'remora-core', importer бросает ошибку (или setup бросает)
  await expect(loadPlugins(pool, { importer })).rejects.toMatchObject({ code: 'invalid_plugin' });
});
it('two plugins declaring the same axis name abort startup', ... rejects with code 'name_taken');
it('getAxis of a missing axis throws unknown_axis', ...);
```

- [ ] **Step 2: Запустить** `npx vitest run --project server packages/server/test/registry.test.ts` — FAIL.
- [ ] **Step 3: Реализовать** `registry.ts`. Конфликт имён проверять до upsert (`SELECT plugin_id FROM time_axis WHERE name = $1`); для недоступного плагина индекс `getAxis` строится по строкам `time_axis` этого `plugin_id`.
- [ ] **Step 4: Запустить** — PASS.
- [ ] **Step 5: Commit** (`packages/server/src/plugins packages/server/test/registry.test.ts`): `feat: plugin registry with degraded startup`.

---

### Task 6: Сервис сущностей

**Files:**
- Create: `packages/server/src/sql/like.ts`, `packages/server/src/services/entities.ts`, `packages/server/test/entities.test.ts`, `packages/server/test/like.test.ts`

**Interfaces:**
- Consumes: `Queryable`, `RemoraError`.
- Produces:
  - `escapeLike(s: string): string` — экранирует `\`, `%`, `_`.
  - `wordPatterns(query: string): string[]` — слова запроса (разделитель — пробельные символы), каждое в виде `%<escapeLike(слово)>%`; пустой запрос — `[]`.
  - `clampLimit(limit?: number): number` — по умолчанию 50, максимум 200; не целое или меньше 1 — `RemoraError('invalid_param')`.
  - `interface EntityRow { entityId: bigint; key: string }`
  - `createEntity(db: Queryable, key: string): Promise<{ entity: EntityRow; created: boolean }>` — идемпотентна (`INSERT … ON CONFLICT (key) DO NOTHING`, при конфликте читает существующую); пустой или состоящий из пробелов `key` — `invalid_name`.
  - `getEntity(db, key): Promise<EntityRow | null>`; `requireEntity(db, key): Promise<EntityRow>` — иначе `RemoraError('unknown_entity', …, { key })`.
  - `findEntities(db, args: { query: string; limit?: number }): Promise<{ rows: EntityRow[]; total: number; truncated: boolean }>` — все слова запроса должны входить в `key` (`ILIKE`, AND), порядок по `key`; пустой запрос — `invalid_param`.

- [ ] **Step 1: Написать падающие тесты.** `like.test.ts` (без БД): `escapeLike('50%_x\\')` → `'50\\%\\_x\\\\'`; `wordPatterns('  bob   ann ')` → `['%bob%', '%ann%']`; `wordPatterns('')` → `[]`; `clampLimit()` → 50, `clampLimit(1000)` → 200, `clampLimit(0)` и `clampLimit(1.5)` бросают `invalid_param`. `entities.test.ts`:

```ts
it('createEntity is idempotent', async () => {
  const a = await createEntity(pool, 'bob'); const b = await createEntity(pool, 'bob');
  expect(a.created).toBe(true); expect(b.created).toBe(false); expect(b.entity.entityId).toBe(a.entity.entityId);
});
it('parallel createEntity of one key yields one row and no error', async () => {
  const rs = await Promise.all(Array.from({ length: 8 }, () => createEntity(pool, 'carl')));
  expect(new Set(rs.map(r => r.entity.entityId)).size).toBe(1);
  expect(rs.filter(r => r.created)).toHaveLength(1);
});
it('requireEntity throws unknown_entity with key', ...);
it('empty key is invalid_name', ...);
it('findEntities matches all words as substrings, case-insensitively', ... ('Bob Smith', 'bob_jones', 'carl' ; query "bob smith" → один результат)
it('findEntities treats % and _ literally', async () => {
  // ключи: 'a%b', 'axb', 'a_c', 'abc'; query 'a%b' → только 'a%b'; query 'a_c' → только 'a_c'
});
it('findEntities reports total and truncated', async () => { /* 5 ключей, limit 2 → rows 2, total 5, truncated true */ });
```

- [ ] **Step 2: Запустить** `npx vitest run --project server packages/server/test/like.test.ts packages/server/test/entities.test.ts` — FAIL.
- [ ] **Step 3: Реализовать** `like.ts` и `entities.ts`. `total` — отдельным `count(*)` с теми же условиями.
- [ ] **Step 4: Запустить** — PASS.
- [ ] **Step 5: Commit** (`packages/server/src packages/server/test`): `feat: entity service and search helpers`.

---

### Task 7: Сервис словарей и список шкал

**Files:**
- Create: `packages/server/src/services/dictionaries.ts`, `packages/server/test/dictionaries.test.ts`

**Interfaces:**
- Consumes: `Queryable`, `wordPatterns`, `RemoraError`; таблицы `relation_type`, `property_type`, `time_axis`.
- Produces:
  - `normalizeName(raw: string): string` — нижний регистр, пробельные последовательности в `_`, удаление всех символов кроме букв Unicode, цифр и `_`, свёртка повторных `_`, обрезка `_` по краям; пустой результат — `RemoraError('invalid_name')`.
  - `interface RelationType { id: number; name: string; description: string; directed: boolean }`
  - `interface PropertyType { id: number; name: string; description: string; valueType: 'number' | 'text' | 'date' | 'bool' | 'json'; singleValued: boolean }`
  - `createRelationType(db, args: { name: string; description: string; directed: boolean }): Promise<RelationType>`; `createPropertyType(db, args: { name: string; description: string; valueType: PropertyType['valueType']; singleValued: boolean }): Promise<PropertyType>` — имя нормализуется; занятое в любом из двух словарей — `name_taken` (с `details: { name, dictionary }`); проверка и вставка выполняются под `pg_advisory_xact_lock(hashtext('remora.type_names'))` внутри транзакции, поэтому параллельные вызовы не создают дубли; пустое `description` — `invalid_param`; неверный `valueType` — `invalid_param`.
  - `listRelationTypes(db): Promise<RelationType[]>`, `listPropertyTypes(db): Promise<PropertyType[]>` (по `name`).
  - `findRelationTypes(db, query: string): Promise<RelationType[]>`, `findPropertyTypes(db, query: string): Promise<PropertyType[]>` — все слова запроса входят в `name` или `description` (`ILIKE`, AND); без оценок.
  - `interface TimeAxisInfo { name: string; description: string; valueSchema: unknown; example: unknown }`; `listTimeAxes(db): Promise<TimeAxisInfo[]>` (по `id`).

- [ ] **Step 1: Написать падающие тесты** `dictionaries.test.ts`:

```ts
it.each([['Любимый цвет', 'любимый_цвет'], ['  Works  At ', 'works_at'], ['hobby!!', 'hobby'], ['a__b', 'a_b']])
  ('normalizeName(%j) = %j', (raw, want) => expect(normalizeName(raw)).toBe(want));
it('normalizeName rejects names that become empty', () => { for (const raw of ['', '   ', '!!!']) expect(() => normalizeName(raw)).toThrow(expect.objectContaining({ code: 'invalid_name' })); });
it('createPropertyType normalizes and stores flags', ... ('Job Title', singleValued true) → name 'job_title');
it('same name in the other dictionary is name_taken', async () => {
  await createRelationType(pool, { name: 'friend of', description: 'дружба', directed: false });
  await expect(createPropertyType(pool, { name: 'Friend_Of', description: 'x', valueType: 'text', singleValued: false }))
    .rejects.toMatchObject({ code: 'name_taken', details: { name: 'friend_of', dictionary: 'relation_type' } });
});
it('parallel creation of one name yields exactly one type', async () => {
  const rs = await Promise.allSettled(Array.from({ length: 6 }, () => createRelationType(pool, { name: 'knows', description: 'знает', directed: false })));
  expect(rs.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  for (const r of rs.filter(r => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason.code).toBe('name_taken');
});
it('find* matches words in name or description and treats % literally', ...);
it('listTimeAxes returns name, description, valueSchema, example from time_axis', async () => { /* seedBasics → оси game_day, real */ });
```

- [ ] **Step 2: Запустить** `npx vitest run --project server packages/server/test/dictionaries.test.ts` — FAIL.
- [ ] **Step 3: Реализовать** `dictionaries.ts`. Для транзакции с advisory-lock принимать `Queryable`; если передан `Pool`, брать клиент и оборачивать в `BEGIN/COMMIT`; если уже клиент в транзакции — использовать его (определение: наличие метода `release` у `Pool`-клиента отличает пул — решить по типу параметра `Queryable | Pool`).
- [ ] **Step 4: Запустить** — PASS.
- [ ] **Step 5: Commit** (`packages/server/src/services/dictionaries.ts packages/server/test/dictionaries.test.ts`): `feat: dictionary service with cross-dictionary name check`.

---

### Task 8: Запуск сервиса и интеграционный тест

**Files:**
- Create: `packages/server/src/app.ts`, `packages/server/test/app.test.ts`
- Modify: `packages/server/src/index.ts` (экспорт публичного API пакета)

**Interfaces:**
- Consumes: `runMigrations` (2), `loadPlugins`, `addPlugin`, `PluginRegistry`, `Logger`, `Importer` (5), сервисы сущностей и словарей (6, 7).
- Produces:
  - `startRemora(opts: { databaseUrl: string; importer?: Importer; logger?: Logger; migrationsDir?: string }): Promise<{ pool: Pool; registry: PluginRegistry; close(): Promise<void> }>` — создаёт пул, применяет миграции, при отсутствии строки `plugin` с именем `remora-core` регистрирует встроенный плагин (`addPlugin` с `package: '@remora/core-plugin'`), затем `loadPlugins`.
  - `src/index.ts` экспортирует: `startRemora`, `runMigrations`, `loadPlugins`, `addPlugin`, сервисы сущностей и словарей, типы.

- [ ] **Step 1: Написать падающий интеграционный тест** `app.test.ts` (`importer` сопоставляет `'@remora/core-plugin'` с импортированным плагином):

```ts
it('starts on an empty database: migrates, registers remora-core and its axes', async () => {
  const app = await startRemora({ databaseUrl: url, importer });
  expect((await listTimeAxes(app.pool)).map(a => a.name)).toEqual(['game_day', 'real', 'story']);
  expect(app.registry.getAxis('story').def.encode({ tome: 2, chapter: 3, scene: 1 })).toBe(2_003_001n);
  await app.close();
});
it('a second start reuses the database and does not duplicate the core plugin', async () => {
  await (await startRemora({ databaseUrl: url, importer })).close();
  const app = await startRemora({ databaseUrl: url, importer });
  const { rows } = await app.pool.query('SELECT count(*)::int AS n FROM plugin');
  expect(rows[0].n).toBe(1);
  await app.close();
});
it('entities and types work against the started app', async () => {
  const app = await startRemora({ databaseUrl: url, importer });
  await createEntity(app.pool, 'bob');
  await createPropertyType(app.pool, { name: 'Job Title', description: 'должность', valueType: 'text', singleValued: true });
  expect((await findEntities(app.pool, { query: 'bo' })).rows.map(r => r.key)).toEqual(['bob']);
  expect((await listPropertyTypes(app.pool)).map(t => t.name)).toEqual(['job_title']);
  await app.close();
});
```

- [ ] **Step 2: Запустить** `npx vitest run --project server packages/server/test/app.test.ts` — FAIL.
- [ ] **Step 3: Реализовать** `app.ts` и `index.ts`.
- [ ] **Step 4: Дополнить раздел 13 спецификации** одним абзацем: `remora-core` поставляется вместе с сервисом, регистрируется автоматически и неотключаем (нельзя удалить; сбой его загрузки останавливает старт).
- [ ] **Step 5: Запустить весь набор** `npx vitest run` и `npm run typecheck` — всё зелёное.
- [ ] **Step 6: Commit** (`packages/server docs/superpowers/specs/2026-10-22-historicity-design.md`): `feat: startRemora bootstrap with bundled core plugin`.

---

## Self-Review

**Покрытие спецификации (в рамках плана 1):** сущности (3) — задачи 3, 6; словари (4) — 3, 7; шкалы времени, `value_schema`/`example`, безвременность (5) — 3, 4, 5, 7; схема свойств, триггер, составной FK, условный EXCLUDE и открытый вопрос 2 (6) — 3; схема связей (7) — 3; создание типов без дедубликатора (9) — 7; события и evidence — только схема (11, 12) — 3; плагины, деградация, `addPlugin` (13) — 4, 5, 8. В планах 2–4: `apply`/`query`, операции фактов и отзыва, `neighbors`, события и evidence как операции, транспорт, служебный API, Docker.

**Отклонения от спецификации (подтверждены пользователем):** встроенный неотключаемый плагин `remora-core` регистрируется автоматически при первом старте (спецификация описывает только ручной `add_plugin`; раздел 13 дополняется в задаче 8); новые коды ошибок `invalid_name`, `invalid_param`, `invalid_plugin`, `invalid_config`; CHECK `instant` в `event_time`; `Importer` по умолчанию — обычный `import()` (поиск пакетов в каталоге плагинов уточняется в плане 4).

**Согласованность имён:** `Queryable`, `Importer`, `Logger`, `PluginRegistry.getAxis`, `buildAxis`, `normalizeName`, `clampLimit`, `wordPatterns` определены в задачах-производителях и используются в задачах-потребителях без переименований.
