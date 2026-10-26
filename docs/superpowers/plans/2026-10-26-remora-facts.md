# Remora Facts (apply / query) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write and read facts: the `apply` batch (entities, dictionaries, properties, relations, retraction, time handling, local names) and the fact-related `query` operations, as in-process service functions on `RemoraApp`.

**Architecture:** Plain service modules over `Queryable` (a transaction client). `apply` opens one transaction, runs ops in order through a dispatcher table, resolves `$name` references, maps DB errors to `RemoraError`, and returns the `{ok, results | error}` envelope. `query` runs read ops in one read-only snapshot. Time values are validated against the axis `valueSchema` (ajv) and encoded by the plugin to `bigint`; spans are stored as `int8range` `[from,to)`.

**Tech Stack:** Node.js/TypeScript (ESM, NodeNext), PostgreSQL 18 via `pg`, `ajv` + `ajv-formats`, vitest + testcontainers (existing helpers `createTestDb`, `seedBasics`, `startRemora`).

**Spec:** `docs/superpowers/specs/2026-10-22-historicity-design.md` (sections 5–7, 9, 10.1, 10.2, 15). Plan 1 (`2026-10-26-remora-foundation.md`) is merged on `master`. Plan 3 adds `neighbors`, events, evidence ops; plan 4 adds HTTP/MCP, JSON Schema contract, admin API.

## Global Constraints

- Language of code/identifiers/errors: English. Tests assert on `RemoraError.code`, not on message text.
- Half-open intervals `[from,to)`; both bounds optional (`NULL` = unbounded); `time_axis` and `time_span` are both NULL for timeless facts.
- Fact is current at `t` on axis `X` iff `time_axis IS NULL OR (time_axis = X AND time_span @> t)`.
- Error codes are exactly those of `ErrorCode` in `@remora/sdk`; no new codes.
- Rows are never deleted; mistakes are retracted (`retracted_at`, optional `retracted_evidence_id`). Reads exclude retracted rows unless `include_retracted: true`.
- Row ids in API output are JSON numbers (`Number(bigint)`); times in API output are plugin-decoded axis values.
- `limit` defaults to 50, max 200 (`clampLimit` in `src/sql/like.ts`); read results with a limit return `total` and `truncated`.
- All SQL is parameterised. Never interpolate user text.
- Commits: add files by name (never `git add -A`; the repo root has unrelated untracked files); end each message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Work on branch `feat/facts` created from `master`. Tests: `npm test`; types: `npm run typecheck` (both from the repo root).

## Rulings (decisions the spec leaves open)

- **R1 write lock.** Every write that touches a single-valued property takes `pg_advisory_xact_lock(hashtextextended('prop:'||entity_id||':'||property_type_id, 0))`. With writers serialised, a remaining EXCLUDE violation (`23P01`) is a real overlap → `single_valued_conflict`. `concurrent_update` is returned only for `40001`/`40P01`. (Spec 15 said EXCLUDE → `concurrent_update`; the lock makes it unnecessary and gives a better error.)
- **R2 closing bound.** Closing a row at `at` requires `lower(time_span) IS NULL OR at > lower`; otherwise `invalid_time` (`at == from` would make an empty span; fix by retract + add).
- **R3 timeless vs timed (single-valued only).** Adding/replacing a timed value while a non-retracted timeless row exists, or a timeless value while a non-retracted timed row exists → `timeless_conflict`. A second timeless value via `add_property` → `single_valued_conflict`. Multi-valued properties have no such checks.
- **R4 references.** `"$name"` is allowed only where an entity key (`entity`, `from`, `to`) or an evidence id (`evidence`) is expected. It resolves to `result.key` of the bound op for entities and `result.id` for evidence. Unbound name, or a bound result lacking the field → `unknown_ref`. Duplicate `as` → `invalid_param`. A numeric `evidence` must exist in `evidence_log` else `unknown_ref`. `add_evidence` itself arrives in plan 3; plan 2 registers no op producing evidence ids.
- **R5 unknown op** → `invalid_param` with `details.op`. Ops deferred to plan 3 (`add_evidence`, `add_event`, `update_event`, `retract_event`) are also `invalid_param` for now.
- **R6 `end_property` / `replace_property` scope.** They act on all non-retracted rows of (entity, property) on the given axis whose `upper(time_span) IS NULL`. `end_*` with nothing to close → `not_found`; `replace_property` with nothing to close just inserts.

## Review Focus

1. Two concurrent `apply` batches replacing the same single-valued property: no raw DB error escapes; end state has exactly one open row. (Task 4, Task 7)
2. Batch atomicity: a failing op N rolls back ops 0..N-1 and reports `op_index = N`. (Task 7)
3. Retracting a row frees its interval: overlapping value can be added afterwards (spec 15 open question 2, EXCLUDE with `retracted_at IS NULL`). (Task 1, Task 4)
4. Axis values beyond 2^53 (e.g. `real` datetime in ms for far-future dates, `story` packed) round-trip exactly through write and read. (Task 2, Task 6)
5. Undirected relation types: `end_relation`/`retract_relation` selector and `relation_history` work from either endpoint. (Task 5, Task 6)

---

### Task 1: Migration 002, registry lookup by id, ajv-formats

**Files:**
- Create: `packages/server/migrations/002_relation_seq.sql`
- Modify: `packages/server/src/plugins/registry.ts`, `packages/server/package.json` (dependency `ajv-formats`)
- Test: `packages/server/test/schema.test.ts` (extend), `packages/server/test/registry.test.ts` (extend)

**Interfaces:**
- Produces: sequence `relation_id_seq` (`bigint`, start 1); `PluginRegistry.getAxisById(id: number): { id: number; name: string; def: TimeAxisDef }` (throws `axis_unavailable` for axes of failed plugins, `unknown_axis` otherwise); `getAxis(name)` now also returns `name`.

- [ ] **Step 1: Write failing tests.** In `schema.test.ts`: `nextval('relation_id_seq')` returns 1 then 2 on a fresh DB; and the retraction/EXCLUDE case — insert a single-valued `property_version` row `[292,)`, set its `retracted_at = now()`, then insert an overlapping row `[300,)` for the same entity/type/axis: succeeds; while without retracting the first, the second insert fails with SQLSTATE `23P01`. In `registry.test.ts`: `getAxisById` returns the axis registered by name; unknown id → `unknown_axis`; an axis whose plugin failed to load (follow the existing degraded-plugin test setup) → `axis_unavailable`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/schema.test.ts packages/server/test/registry.test.ts`; expect the new tests to fail.
- [ ] **Step 3: Implement.** SQL: `CREATE SEQUENCE relation_id_seq AS bigint;`. Registry: keep `axesById` and `unavailableAxisIds` maps next to the existing name maps (fill unavailable ids in the failed-plugin branch from the `time_axis` rows already queried there). `npm install ajv-formats -w @remora/server` (use exact installed version, check ESM default-import typing under NodeNext).
- [ ] **Step 4: Run** the full suite `npm test` and `npm run typecheck`; expect green.
- [ ] **Step 5: Commit** the changed files by name: `feat: relation id sequence, axis lookup by id, ajv-formats`.

### Task 2: Time parsing, validation, encoding, formatting

**Files:**
- Create: `packages/server/src/services/time.ts`
- Test: `packages/server/test/time.test.ts`

**Interfaces:**
- Consumes: `PluginRegistry.getAxis`, `getAxisById` (Task 1); `RemoraError`.
- Produces:
  - `interface AxisRef { id: number; name: string; def: TimeAxisDef }`
  - `interface Span { axis: AxisRef; lo: bigint | null; hi: bigint | null }`
  - `interface Moment { axis: AxisRef; at: bigint }`
  - `type When = { axis: AxisRef; at: bigint } | { axis: AxisRef; from: bigint; to: bigint }` (`during` is `[from,to)`)
  - `interface TimeOut { axis: string; from?: unknown; to?: unknown }`
  - `parseSpans(registry, raw: unknown): Span[]` — for `add_*`: `undefined`/`null` → `[]`; an object or array of `{axis, from?, to?}`.
  - `parseMoment(registry, raw: unknown): Moment` — for `replace_*`/`end_*`: `{axis, at}`, both required.
  - `parseWhen(registry, raw: unknown): When | undefined` — `undefined` → `undefined`; `{axis, at}` or `{axis, during:[a,b]}`.
  - `formatTime(registry, axisId: number | null, lo: string | null, hi: string | null): TimeOut | null` — `null` axis → `null`; decodes bounds via `def.decode(BigInt(x))`; omits absent bounds.

Behaviour: every axis value is validated with ajv against `def.valueSchema` (compile once per schema object; formats enabled) → `invalid_time` with `details.reason` = ajv error text; `encode` exceptions → `invalid_time`. Unknown axis → `unknown_axis`; shape errors (missing `axis`, `at` mixed with `from`/`to`, array of length ≠ 2 in `during`, non-object) → `invalid_param`; duplicate axis in one list → `invalid_param`; `lo >= hi` (both set) → `invalid_time`; `during` with `a >= b` → `invalid_time`.

- [ ] **Step 1: Write failing tests** using a fake registry with axes `game_day` (integer ≥ 0; encode `BigInt`) and `big` (encode of `{"v": string}` → `BigInt(v)`): `parseSpans` for absent/object/array; `{axis:'game_day'}` → `lo/hi null`; `{from:5,to:5}` → `invalid_time`; `{axis:'game_day', from:-1}` → `invalid_time` (schema); unknown axis → `unknown_axis`; duplicate axis → `invalid_param`; `parseMoment` with `{axis,at:292}` → `at === 292n`; missing `at` → `invalid_param`; `parseWhen` both forms and `undefined`; `formatTime` round-trips `9007199254740993` (value `{v:'9007199254740993'}`) exactly as BigInt string → decoded value equal; `formatTime(reg, null, null, null)` → `null`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/time.test.ts`; expect FAIL (module missing).
- [ ] **Step 3: Implement** the functions above in `time.ts`.
- [ ] **Step 4: Run** the test file, then `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `src/services/time.ts`, `test/time.test.ts`: `feat: time parsing and encoding for facts`.

### Task 3: Value validation by `value_type`

**Files:**
- Create: `packages/server/src/services/values.ts`
- Test: `packages/server/test/values.test.ts`

**Interfaces:**
- Produces: `checkValue(type: ValueType, value: unknown, ctx: { property: string }): void` — throws `value_type_mismatch` (`details: {property, valueType}`) when invalid. Rules: `number` finite JS number; `text` string (may be empty); `bool` boolean; `date` string valid per ajv-formats `date` or `date-time`; `json` anything except `undefined` (JSON `null` is allowed).

- [ ] **Step 1: Write failing tests** for each type with one valid and several invalid inputs: `number` rejects `"1"`, `NaN`, `Infinity`; `text` rejects `null` and `5`; `date` accepts `"2026-10-26"` and `"2026-10-26T10:00:00Z"`, rejects `"26.10.2026"` and `"2026-13-40"`; `bool` rejects `"true"`; `json` accepts `null`, `{a:1}`, `[1]`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/values.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `checkValue` (shared Ajv instance with formats; may reuse one from `time.ts` by extracting a tiny `ajv.ts` module if both need it — keep a single instance).
- [ ] **Step 4: Run** test file + typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat: property value validation`.

### Task 4: Property writes

**Files:**
- Create: `packages/server/src/services/properties.ts`
- Test: `packages/server/test/properties.test.ts`

**Interfaces:**
- Consumes: Task 2 (`Span`, `Moment`), Task 3 (`checkValue`), `requireEntity`, dictionary tables, `Queryable` (a client inside a transaction).
- Produces (all take `db: Queryable`):
  - `addProperty(db, a: { entity: string; property: string; value: unknown; spans: Span[]; evidenceId?: bigint }): Promise<{ ids: bigint[] }>` — one row per span; no spans → one timeless row.
  - `replaceProperty(db, a: { entity; property; value; moment?: Moment; evidenceId? }): Promise<{ closed: bigint[]; retracted: bigint[]; ids: bigint[] }>` — with `moment`: close open rows on the axis at `moment.at` (R2, R6) and insert `[at,)`; without: retract the current non-retracted timeless row(s) and insert a new timeless one.
  - `endProperty(db, a: { entity; property; moment: Moment; evidenceId? }): Promise<{ closed: bigint[] }>`
  - `retractProperty(db, a: { id: bigint; evidenceId? }): Promise<{ id: bigint }>` — `not_found` if no row or already retracted.
  - Internal `resolveProperty(db, name)` → `{id, valueType, singleValued}`; unknown → `unknown_type`. Property name is looked up as given after `normalizeName`.
  - Internal `lockProperty(db, entityId, typeId)` implementing R1; call it in all four functions before reading rows.

Rules: R1–R3, R6 as above. Map `23P01` raised by INSERT to `RemoraError('single_valued_conflict', ..., {entity, property})` (catch inside the module; `ids`/`details` per row). `closed` rows get `UPDATE ... SET time_span = int8range(lower(time_span), $at, '[)')`. Evidence ids, when given, are stored in `evidence_id` (insert) or `retracted_evidence_id` (retract); `end_*` closing has no evidence column — the optional `evidenceId` on `endProperty` is accepted and ignored in v1 (document in a code comment).

- [ ] **Step 1: Write failing tests** (use `createTestDb`, `runMigrations`, `seedBasics`; each test inside `BEGIN`/`ROLLBACK` on a pooled client, or a fresh DB per file):
  - spec table: `replaceProperty` Junior at 292, Senior at 300, `endProperty` at 310 → rows `[292,300)` Junior, `[300,310)` Senior (assert via SQL on `lower/upper`).
  - multi-valued `nickname`: two `addProperty` with open spans coexist.
  - single-valued `addProperty` with overlapping span → `single_valued_conflict`; same interval on another axis (`real`) succeeds.
  - R2: `replaceProperty` at 291 when open row starts at 292 → `invalid_time`; at 292 → `invalid_time`.
  - R3: timeless then timed → `timeless_conflict` (both orders, via add and replace); two timeless adds → `single_valued_conflict`; timeless `replaceProperty` retracts the old and inserts the new; multi-valued unaffected.
  - Retraction frees the interval (Review Focus 3): add `[292,)`, `retractProperty`, then add `[300,)` succeeds; `retractProperty` twice → `not_found`.
  - `endProperty` with nothing open → `not_found`; `unknown_type`, `unknown_entity`, `value_type_mismatch` for `job_title` = 5.
  - Concurrency (Review Focus 1): two clients each in their own transaction call `replaceProperty` for the same entity/type at `at=300` and `at=301` concurrently (`Promise.all`, each committing); both commit or one gets a `RemoraError` of code `invalid_time` / `single_valued_conflict` — never a raw pg error — and afterwards exactly one non-retracted open row exists.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/properties.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `properties.ts`.
- [ ] **Step 4: Run** test file + typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat: property write services`.

### Task 5: Relation writes

**Files:**
- Create: `packages/server/src/services/relations.ts`
- Test: `packages/server/test/relations.test.ts`

**Interfaces:**
- Consumes: Task 2, `requireEntity`, `relation_id_seq` (Task 1).
- Produces:
  - `type RelationRef = { relationId: bigint } | { type: string; from: string; to: string }`
  - `addRelation(db, a: { type: string; from: string; to: string; spans: Span[]; evidenceId?: bigint }): Promise<{ relationId: bigint; ids: bigint[] }>` — new `relation_id` from the sequence, one row per span (none → one timeless row). Unknown type → `unknown_type`.
  - `endRelation(db, a: { ref: RelationRef; moment: Moment; evidenceId?: bigint }): Promise<{ closed: bigint[] }>` — closes non-retracted rows on `moment.axis` with `upper(time_span) IS NULL` (R2 applies per row); none matched → `not_found`.
  - `retractRelation(db, a: { ref: RelationRef; axis?: AxisRef; evidenceId?: bigint }): Promise<{ retracted: bigint[] }>` — all non-retracted rows of the matching relation(s) (or only axis rows); none → `not_found`.
  - Internal `matchRows(db, ref)`: for a selector, match `(src=from AND dst=to)` and, if the type is undirected, also `(src=to AND dst=from)`; non-retracted rows only. `{relationId}` for an unknown id → `not_found`.

- [ ] **Step 1: Write failing tests:** `addRelation` with two spans on two axes shares one `relation_id` and returns two ids; timeless add → one row with NULL axis/span; `endRelation` by `relationId` and by selector; selector with nothing matching → `not_found`; **undirected** type: relation added `a→b`, ended with selector `{from:'b', to:'a'}` succeeds, and for a directed type the reversed selector gives `not_found`; `retractRelation` all rows vs one axis; ended-twice → second `not_found`; two parallel relations of the same type between the same pair are both closed by one selector call; unknown entity/type codes.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/relations.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `relations.ts`.
- [ ] **Step 4: Run** test file + typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat: relation write services`.

### Task 6: Fact reads

**Files:**
- Create: `packages/server/src/services/facts-read.ts`
- Test: `packages/server/test/facts-read.test.ts`

**Interfaces:**
- Consumes: Task 2 (`When`, `formatTime`), `requireEntity`, `clampLimit`.
- Produces:
  - `whenClause(when: When | undefined, firstParam: number): { sql: string; params: unknown[] }` — SQL fragment (empty `true` when `undefined`) for a table with `time_axis`/`time_span`: `at` → `(time_axis IS NULL OR (time_axis = $n AND time_span @> $m::bigint))`; `during` → `(time_axis IS NULL OR (time_axis = $n AND time_span && int8range($a,$b,'[)')))`.
  - `interface PropertyRow { id: number; value: unknown; time: TimeOut | null; evidenceId: number | null; recordedAt: string; retractedAt?: string }`
  - `propertyAt(db, registry, a: { entity: string; property: string; when: When }): Promise<PropertyRow[]>` (order by `id`)
  - `propertyHistory(db, registry, a: { entity; property; axis?: string; includeRetracted?: boolean }): Promise<PropertyRow[]>` (order by axis, `lower(time_span)` nulls first, `id`)
  - `interface RelationRow { id: number; relationId: number; type: string; from: string; to: string; time: TimeOut | null; evidenceId: number | null; recordedAt: string; retractedAt?: string }`
  - `relationHistory(db, registry, a: { entity: string; relationTypes?: string[]; direction?: 'out' | 'in' | 'both'; when?: When; includeRetracted?: boolean; limit?: number }): Promise<{ rows: RelationRow[]; total: number; truncated: boolean }>` — direction default `both`; undirected types match from either side regardless of `direction`; order by `relation_id`, `id`.

SQL selects bounds as `lower(time_span)::text AS lo, upper(time_span)::text AS hi` and calls `formatTime`; ids via `Number(...)`; timestamps `toISOString()`. Unknown property/relation type → `unknown_type`; unknown entity → `unknown_entity`.

- [ ] **Step 1: Write failing tests** (seed with services from Tasks 4–5 in a fresh DB): `propertyAt` at 295 returns Junior, at 300 Senior, at 310 none; timeless value appears at any `when`; `during [290,300)` returns Junior only, `[299,301)` returns both; multi-valued returns several; `propertyHistory` hides retracted rows by default and shows them (with `retractedAt`) when `includeRetracted`; axis filter; `relationHistory` direction out/in/both and undirected-from-either-side; `relationTypes` filter; `limit`/`total`/`truncated` (insert 3 relations, `limit: 2`); **big values** (Review Focus 4): axis `big` with value `9007199254740993` returned unchanged in `time.from`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/facts-read.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `facts-read.ts`.
- [ ] **Step 4: Run** test file + typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat: fact read services`.

### Task 7: `apply` engine

**Files:**
- Create: `packages/server/src/api/apply.ts`, `packages/server/src/api/args.ts`
- Test: `packages/server/test/apply.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5, `createEntity`, `createRelationType`, `createPropertyType`, `PluginRegistry`, `pg.Pool`.
- Produces:
  - `type ApplyResponse = { ok: true; results: unknown[] } | { ok: false; error: { op_index: number; code: ErrorCode; message: string; details?: Record<string, unknown> } }`
  - `apply(pool: pg.Pool, registry: PluginRegistry, request: unknown): Promise<ApplyResponse>`
  - `args.ts` helpers used by the dispatcher: `str(o, key)`, `optStr`, `bool`, `obj`, `arr` — throw `RemoraError('invalid_param', ..., {field})` on wrong shape.

Behaviour: request must be `{ops: object[]}` with ≥1 op (else the response is `ok:false` with `op_index: -1`, `invalid_param`). One `pool.connect()` client: `BEGIN`, ops in order, `COMMIT`; any thrown `RemoraError` → `ROLLBACK` and `{ok:false,error}` with the op's index; pg errors map `23P01` → `single_valued_conflict`, `40001`/`40P01` → `concurrent_update`, `23503` (FK) → `invalid_param`; any other error rolls back and is rethrown. Always `release()` the client. Dispatcher table keyed by `op`; ops and field names exactly:

| op | fields | result |
|---|---|---|
| `create_entity` | `key` | `{key, created}` |
| `create_relation_type` | `name, description, directed` | the `RelationType` |
| `create_property_type` | `name, description, value_type, single_valued` | the `PropertyType` |
| `add_property` | `entity, property, value, time?, evidence?` | `{ids}` |
| `replace_property` | `entity, property, value, time?, evidence?` (`time` = `{axis, at}`) | `{closed, retracted, ids}` |
| `end_property` | `entity, property, time, evidence?` | `{closed}` |
| `retract_property` | `id, evidence?` | `{id}` |
| `add_relation` | `type, from, to, time?, evidence?` | `{relation_id, ids}` |
| `end_relation` | `relation_id` or `type+from+to`, `time`, `evidence?` | `{closed}` |
| `retract_relation` | `relation_id` or `type+from+to`, `axis?`, `evidence?` | `{retracted}` |

Any op may carry `as`; its result is bound for `$name` references per R4. `value_type` of a property type is passed as `valueType`, etc. (snake_case in the API, camelCase in services). Result bigints are converted to numbers.

- [ ] **Step 1: Write failing tests** (full `startRemora`-style app or `createTestDb` + migrations + a fake registry with `game_day`/`real`):
  - the spec example batch: create entities `bob`, `google`; types; `replace_property` Junior at 292; `add_relation works_at` from 292 → `ok:true`, results in order, right shapes.
  - local names: `create_entity` with `as:'c'` then `add_property` with `entity:'$c'` works; `$missing` → `unknown_ref` with right `op_index`; duplicate `as` → `invalid_param`; numeric `evidence` not in `evidence_log` → `unknown_ref`.
  - atomicity (Review Focus 2): batch `[create_entity x, add_property on unknown type]` → `ok:false`, `op_index: 1`, `unknown_type`, and entity `x` does not exist afterwards.
  - each op sees earlier ops' results (replace then end in the same batch).
  - `invalid_param` for unknown op name, missing fields, empty `ops`, non-object body; deferred plan-3 op names → `invalid_param`.
  - concurrency (Review Focus 1): two `apply` calls in parallel replacing the same property at 300 and 301 → each response is `ok:true` or `ok:false` with a typed code; final DB has exactly one open non-retracted row.
  - a unique-violation-free replay: applying the same `create_entity` batch twice is idempotent.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/apply.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `apply.ts` (dispatcher, reference resolution per R4, error mapping) and `args.ts`.
- [ ] **Step 4: Run** test file + typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat: apply batch engine`.

### Task 8: `query` engine, app wiring, end-to-end

**Files:**
- Create: `packages/server/src/api/query.ts`
- Modify: `packages/server/src/app.ts` (add `apply(request)` and `query(request)` to `RemoraApp`), `packages/server/src/index.ts` (exports)
- Test: `packages/server/test/query.test.ts`, `packages/server/test/facts-e2e.test.ts`

**Interfaces:**
- Consumes: Tasks 6–7, `getEntity`, `findEntities`, dictionary list/find functions, `listTimeAxes`.
- Produces:
  - `type QueryResponse = { ok: true; results: unknown[] } | { ok: false; error: {...same shape as apply...} }`
  - `query(pool: pg.Pool, registry: PluginRegistry, request: unknown): Promise<QueryResponse>` — `{ops:[...]}`; runs in one `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction; same error mapping as `apply`.
  - Ops: `get_entity{key}` → `{key}` (`unknown_entity` if missing); `find_entities{query, limit?}` → `{rows, total, truncated}`; `property_at{entity, property, when}` (`when` required) → `{rows}`; `property_history{entity, property, axis?, include_retracted?}` → `{rows}`; `relation_history{entity, relation_types?, direction?, when?, include_retracted?, limit?}` → `{rows, total, truncated}`; `list_relation_types`, `list_property_types`, `find_relation_types{query}`, `find_property_types{query}`, `list_time_axes` → `{rows}`. `neighbors` and event/evidence ops → `invalid_param` until plan 3.
  - `RemoraApp` gains `apply(request: unknown): Promise<ApplyResponse>` and `query(request: unknown): Promise<QueryResponse>` bound to its pool and registry; `index.ts` exports `apply`, `query`, and the response types.

- [ ] **Step 1: Write failing tests.** `query.test.ts`: each op through `query` with the seeded data from Tasks 4–6 (shape of `rows`, `when` parsing errors surface as `invalid_time`/`unknown_axis`/`invalid_param`, `property_at` without `when` → `invalid_param`, `limit` clamp). `facts-e2e.test.ts` uses the real `startRemora` with the bundled core plugin (axes `game_day`, `real`, `story` if present in core defaults — otherwise add them to `plugin.config` via `UPDATE` before start) and replays the spec scenarios through `app.apply` / `app.query`: Bob's job history (`Junior`→`Senior`→ended), nicknames, `works_at` on two axes with shared `relation_id`, `end_relation` by selector, correction by retract + add in one batch, `property_history` with `include_retracted`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/query.test.ts packages/server/test/facts-e2e.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `query.ts`; wire `apply`/`query` into `startRemora` and export from `index.ts`.
- [ ] **Step 4: Run** the full suite `npm test` and `npm run typecheck`; expect all green.
- [ ] **Step 5: Commit** `feat: query engine and app wiring for facts`.

---

## Parked for plan 4 (carry-over)

Advisory lock around migrations and core registration; static import of core plugin; smoke test of `startRemora` without the fake importer; plugin name vs row name check; `close()` idempotence; JSON Schema contract for `apply`/`query` (hand validators in `api/args.ts` become generated from it).
