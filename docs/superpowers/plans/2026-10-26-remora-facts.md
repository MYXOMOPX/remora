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
- API (apply/query) input and output field names are snake_case (`relation_id`, `value_type`, `single_valued`, `evidence_id`, `recorded_at`, `retracted_at`, `include_retracted`); service modules use camelCase and `bigint` ids; `api/` converts both ways.
- `limit` defaults to 50, max 200 (`clampLimit` in `src/sql/like.ts`); read results with a limit return `total` and `truncated`.
- All SQL is parameterised. Never interpolate user text. `jsonb` values are always sent as `JSON.stringify(value)` with a `$n::jsonb` cast (node-pg would turn a JS array into a PG array literal and a JS string into invalid JSON). `bigint` parameters may be passed as JS `bigint` (node-pg calls `toString()`); bigint columns come back as strings → `BigInt(x)`.
- `apply` runs at the default `READ COMMITTED` isolation (required by R1: each statement after the advisory lock sees rows committed by the previous lock holder). Do not raise it.
- Tests touching the DB use one fresh database per test via a local `withDb` helper exactly like `test/schema.test.ts` (`createTestDb` → `runMigrations` → `seedBasics` → `drop`). No shared state between tests, no BEGIN/ROLLBACK harness. After an expected DB-level error inside a transaction the transaction is aborted, so each expected error is its own test (or the last statement of its test).
- Commits: add files by name (never `git add -A`; the repo root has unrelated untracked files); end each message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Work on branch `feat/facts` created from `master`. The worktree has no `node_modules`: run `npm install` once at the repo root before Task 1. Tests: `npm test`; types: `npm run typecheck` (both from the repo root).

## Rulings (decisions the spec leaves open or that deviate from it)

- **R0 sequence name.** `relation_id_seq` is already the identity sequence of `relation.id`; the logical id sequence is `relation_logical_id_seq` (migration `002_relation_logical_id_seq.sql`).
- **R1 write lock.** Every property write (single- and multi-valued alike, for simplicity) takes `pg_advisory_xact_lock(hashtextextended('prop:' || $entityId || ':' || $propertyTypeId, 0))` before it reads any `property_version` row. `retractProperty` first reads `entity_id, property_type_id` of the target row (no lock needed for that read), then takes the lock, then updates with `WHERE id = $1 AND retracted_at IS NULL`. With writers serialised under READ COMMITTED, a remaining EXCLUDE violation (`23P01`) is a real overlap → `single_valued_conflict`. `concurrent_update` is returned only for `40001`/`40P01` (e.g. two batches locking the same two properties in opposite order deadlock → `40P01`). **Deviation from spec 15** (which maps EXCLUDE in `replace_property` to `concurrent_update`): the lock makes the race impossible and gives a precise error.
- **R2 closing bound.** Closing a row at `at` requires `lower(time_span) IS NULL OR at > lower(time_span)`; otherwise `invalid_time` with `details: {id, from, at}` and nothing is changed. **Deviation from spec 6** ("`at ≥ from`"): `at == from` would make an empty span, which `CHECK (NOT isempty(time_span))` rejects; the fix is retract + add. If any candidate row fails R2, the whole op fails.
- **R3 timeless vs timed (single-valued only).** Adding/replacing a timed value while a non-retracted timeless row exists, or adding/replacing a timeless value while any non-retracted timed row exists (open or closed, any axis) → `timeless_conflict`. A second timeless value via `add_property` → `single_valued_conflict` (from EXCLUDE). Multi-valued properties have no such checks.
- **R4 references.** A string starting with `$` is a reference only where an entity key (`entity`, `from`, `to`) or an evidence id (`evidence`) is expected; there it is always a reference (no escaping). It resolves to `result.key` of the bound op for entities and `result.id` for evidence. Unbound name (including a name declared later in the batch or by the same op), or a bound result lacking the field → `unknown_ref` with `details: {ref}`. `as` must be a non-empty string not starting with `$`, else `invalid_param`; duplicate `as` → `invalid_param` at the second declaring op. A name is bound only after its op succeeds. The result object of an op that declared `as` additionally carries `as: "<name>"` (spec 10.1 "у операций с `as` — ссылку"). `create_entity` with a `key` starting with `$` → `invalid_name` (such an entity could never be referenced). A numeric `evidence` must be a positive integer present in `evidence_log`, else `unknown_ref`; any other type → `invalid_param`. `add_evidence` itself arrives in plan 3; plan 2 registers no op producing evidence ids.
- **R5 unknown op** → `invalid_param` with `details.op`. Ops deferred to plan 3 (`add_evidence`, `add_event`, `update_event`, `retract_event`) are also `invalid_param` for now.
- **R6 `end_*` / `replace_property` scope.** They act on all non-retracted rows of (entity, property) — or of the matched relation(s) — on the given axis whose `upper(time_span) IS NULL`. `end_*` with nothing to close → `not_found`; `replace_property` with nothing to close just inserts. Closing is `UPDATE ... SET time_span = int8range(lower(time_span), $at, '[)')`.
- **R7 `during`.** `when.during: [a, b]` is half-open `[a, b)`, both bounds required; `a >= b` → `invalid_time`. (The spec example `[290, 310]` does not say.)
- **R8 evidence on `end_*`.** The schema has no column for "closed by evidence"; `end_property`/`end_relation` validate `evidence` per R4 and then ignore it in v1 (code comment). `replace_property` stores its evidence on the inserted row (`evidence_id`) and, for the timeless form, also on the retracted row (`retracted_evidence_id`). `retract_*` stores it in `retracted_evidence_id`.
- **R9 `property_history` axis filter** keeps timeless rows (`time_axis IS NULL OR time_axis = $axis`), consistent with "timeless facts appear for any `when`" (spec 10.2).
- **R10 time shapes.** `time` on `add_*` is an object or a non-empty array of `{axis, from?, to?}` (empty array → `invalid_param`; duplicate axis → `invalid_param`). `time` on `replace_property`/`end_*` is `{axis, at}`. Encoded values must be JS `bigint` within int8 (`-2^63 .. 2^63-1`), else `invalid_time`.

## Review Focus

1. Two concurrent `apply` batches replacing the same single-valued property: no raw DB error escapes; end state has exactly one open row. (Task 4, Task 7)
2. Batch atomicity: a failing op N rolls back ops 0..N-1 and reports `op_index = N`. (Task 7)
3. Retracting a row frees its interval: overlapping value can be added afterwards (spec 15 open question 2; DB-level test already exists in `schema.test.ts` "retracted row does not block"; service-level test in Task 4).
4. Axis values beyond 2^53 round-trip exactly through write and read. None of the core axes reaches 2^53 (datetime ms ≤ 8.64e15, story ≤ 1e9), so this is tested with the fake `big` axis (Task 2 helper, Tasks 2 and 6).
5. Undirected relation types: `end_relation`/`retract_relation` selector and `relation_history` work from either endpoint. (Task 5, Task 6)

---

### Task 1: Migration 002, registry lookup by id, ajv-formats

**Files:**
- Create: `packages/server/migrations/002_relation_logical_id_seq.sql`
- Modify: `packages/server/src/plugins/registry.ts`, `packages/server/package.json` (dependency `ajv-formats`), `package-lock.json`
- Test: `packages/server/test/schema.test.ts` (extend), `packages/server/test/registry.test.ts` (extend), `packages/server/test/migrate.test.ts` (update)

**Interfaces:**
- Produces: sequence `relation_logical_id_seq` (`bigint`, start 1); `PluginRegistry.getAxisById(id: number): { id: number; name: string; def: TimeAxisDef }`; `getAxis(name)` now returns the same shape (adds `name`).
- `getAxisById` semantics: id served by a loaded plugin → the axis; id present in `time_axis` but not served (its plugin failed, or the plugin no longer declares it) → `axis_unavailable`; id absent from `time_axis` → `unknown_axis`. Implementation: at the end of `loadPlugins` read `SELECT id, name FROM time_axis`; keep `axesById` for served axes and the rest as unavailable ids.

- [ ] **Step 1: Write failing tests.** `schema.test.ts`: `SELECT nextval('relation_logical_id_seq') AS n` returns `'1'` then `'2'` (bigint comes back as string) on a fresh DB. (The EXCLUDE-with-retraction case is already covered by the existing test "retracted row does not block"; do not duplicate it.) `migrate.test.ts`: the first `runMigrations` now returns `['001_init.sql', '002_relation_logical_id_seq.sql']` and `schema_migration` has both names — update the existing expectations. `registry.test.ts`: `getAxisById(reg.getAxis('day').id)` deep-equals `reg.getAxis('day')` and has `name: 'day'`; `getAxisById(9999)` → `unknown_axis`; in the existing "a plugin whose setup throws is unavailable" setup (axis `bad_axis` pre-registered in `time_axis`), `getAxisById(<id of bad_axis from time_axis>)` → `axis_unavailable`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/schema.test.ts packages/server/test/registry.test.ts packages/server/test/migrate.test.ts`; expect the new tests to fail.
- [ ] **Step 3: Implement.** SQL: `CREATE SEQUENCE relation_logical_id_seq AS bigint;`. Registry as described above. `npm install ajv-formats@^3 -w @remora/server`. Under NodeNext the default import of this CJS package is the module namespace, so `import addFormats from 'ajv-formats'; addFormats(ajv)` fails typecheck (TS2349, verified). Use exactly: `import addFormatsModule from 'ajv-formats'; const addFormats = addFormatsModule.default;` (works in both `tsc` and vitest/Node). Ajv itself stays `import { Ajv } from 'ajv'`.
- [ ] **Step 4: Run** the full suite `npm test` and `npm run typecheck`; expect green.
- [ ] **Step 5: Commit** the changed files by name: `feat: relation id sequence, axis lookup by id, ajv-formats`.

### Task 2: Time parsing, validation, encoding, formatting

**Files:**
- Create: `packages/server/src/services/ajv.ts`, `packages/server/src/services/time.ts`, `packages/server/test/helpers/axes.ts`
- Test: `packages/server/test/time.test.ts`

**Interfaces:**
- Consumes: `PluginRegistry.getAxis`, `getAxisById` (Task 1); `RemoraError`.
- Produces:
  - `ajv.ts`: `export const ajv = new Ajv({ strict: false })` with `addFormats(ajv)` applied (import style from Task 1); `export function compileCached(schema: object): ValidateFunction` (WeakMap cache keyed by schema object). The single Ajv instance for value/time validation; Task 3 uses it too. (`registry.ts` keeps its own config-checking instance.)
  - `interface AxisRef { id: number; name: string; def: TimeAxisDef }` (same shape `getAxis`/`getAxisById` return)
  - `interface Span { axis: AxisRef; lo: bigint | null; hi: bigint | null }`
  - `interface Moment { axis: AxisRef; at: bigint }`
  - `type When = { axis: AxisRef; at: bigint } | { axis: AxisRef; from: bigint; to: bigint }` (`during` per R7)
  - `interface TimeOut { axis: string; from?: unknown; to?: unknown }`
  - `encodeValue(axis: AxisRef, value: unknown): bigint` — ajv-validate against `def.valueSchema` (`invalid_time`, `details: {axis, reason: ajv.errorsText(...)}`), then `def.encode`; a thrown `RemoraError` passes through, any other throw → `invalid_time`; non-bigint or out-of-int8 result → `invalid_time` (R10).
  - `parseSpans(registry, raw: unknown): Span[]` — for `add_*`: `undefined` → `[]`; an object or non-empty array of `{axis, from?, to?}` (R10). `null` → `invalid_param`.
  - `parseMoment(registry, raw: unknown): Moment` — `{axis, at}`, both required.
  - `parseWhen(registry, raw: unknown): When | undefined` — `undefined` → `undefined`; `{axis, at}` or `{axis, during:[a,b]}` (exactly one of `at`/`during`).
  - `formatTime(registry, axisId: number | null, lo: string | null, hi: string | null): TimeOut | null` — `null` axis → `null`; looks the axis up with `getAxisById`; decodes bounds via `def.decode(BigInt(x))`; omits absent bounds.
- Test helper `test/helpers/axes.ts`:
  - `intAxis(name): TimeAxisDef` — `valueSchema {type:'integer', minimum:0}`, encode `BigInt(v)`, decode `Number(n)`.
  - `bigAxis(name): TimeAxisDef` — `valueSchema {type:'object', properties:{v:{type:'string', pattern:'^[0-9]+$'}}, required:['v'], additionalProperties:false}`, encode `BigInt(v.v)`, decode `{v: n.toString()}`.
  - `fakeRegistry(axes: { id: number; def: TimeAxisDef }[]): PluginRegistry` — `getAxis`/`getAxisById` over the list (`unknown_axis` otherwise), `status()` → `[]`.
  - `seedAxes(db, s: Seeded): Promise<PluginRegistry>` — inserts a `time_axis` row `big` (plugin = the `test` plugin row created by `seedBasics`) and returns `fakeRegistry` with `game_day` (`s.axes.gameDay`, `intAxis`), `real` (`s.axes.real`, `intAxis`) and `big` (new id, `bigAxis`). Used by Tasks 4–7.

Behaviour: unknown axis → `unknown_axis` (or `axis_unavailable` from the registry); shape errors (non-object, missing or non-string `axis`, `at` mixed with `from`/`to` or with `during`, `during` not an array of length 2) → `invalid_param`; duplicate axis in one list → `invalid_param`; `lo >= hi` (both set) → `invalid_time`.

- [ ] **Step 1: Write failing tests** with `fakeRegistry([{id:1, def:intAxis('game_day')}, {id:2, def:bigAxis('big')}])`: `parseSpans` for `undefined` (→ `[]`), object, two-element array; `[]` → `invalid_param`; `{axis:'game_day'}` → `lo === null && hi === null`; `{axis:'game_day', from:5, to:5}` → `invalid_time`; `{axis:'game_day', from:-1}` → `invalid_time` (schema); `{axis:'game_day', from:'x'}` → `invalid_time`; `{axis:'nope'}` → `unknown_axis`; `[{axis:'game_day'},{axis:'game_day'}]` → `invalid_param`; `{from:1}` → `invalid_param`; `parseMoment({axis:'game_day', at:292})` → `at === 292n`; missing `at` → `invalid_param`; `parseWhen` with `at`, with `during:[290,300]` (→ `from 290n, to 300n`), with `during:[300,300]` → `invalid_time`, with `during:[1]` → `invalid_param`, `undefined` → `undefined`; `encodeValue(big, {v:'9223372036854775808'})` → `invalid_time` (out of int8); `formatTime(reg, 2, '9007199254740993', null)` → `{axis:'big', from:{v:'9007199254740993'}}` (no `to` key); `formatTime(reg, null, null, null)` → `null`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/time.test.ts`; expect FAIL (module missing).
- [ ] **Step 3: Implement** `ajv.ts`, `time.ts`, `test/helpers/axes.ts`.
- [ ] **Step 4: Run** the test file, then `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `src/services/ajv.ts`, `src/services/time.ts`, `test/helpers/axes.ts`, `test/time.test.ts`: `feat: time parsing and encoding for facts`.

### Task 3: Value validation by `value_type`

**Files:**
- Create: `packages/server/src/services/values.ts`
- Test: `packages/server/test/values.test.ts`

**Interfaces:**
- Consumes: `ajv` from `services/ajv.ts` (Task 2), `ValueType` from `services/dictionaries.ts`.
- Produces: `checkValue(type: ValueType, value: unknown, ctx: { property: string }): void` — throws `value_type_mismatch` (`details: {property, valueType}`) when invalid. Rules: `number` finite JS number; `text` string (may be empty); `bool` boolean; `date` string valid per ajv-formats `date` (`2026-10-26`) or `date-time` (`2026-10-26T10:00:00Z`; ajv-formats 3 requires a zone in `date-time`); `json` anything except `undefined` (JSON `null` is allowed and stored as jsonb `null`).

- [ ] **Step 1: Write failing tests** for each type with one valid and several invalid inputs: `number` accepts `0`, `-1.5`; rejects `"1"`, `NaN`, `Infinity`; `text` accepts `""`, rejects `null` and `5`; `date` accepts `"2026-10-26"` and `"2026-10-26T10:00:00Z"`, rejects `"26.10.2026"`, `"2026-13-40"`, `"2026-10-26T10:00:00"` (no zone) and `20261026`; `bool` accepts `false`, rejects `"true"` and `0`; `json` accepts `null`, `{a:1}`, `[1]`, rejects `undefined`. The thrown error has `details` `{property:'p', valueType:<type>}`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/values.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `checkValue`.
- [ ] **Step 4: Run** test file + typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat: property value validation`.

### Task 4: Property writes

**Files:**
- Create: `packages/server/src/services/properties.ts`
- Test: `packages/server/test/properties.test.ts`

**Interfaces:**
- Consumes: Task 2 (`Span`, `Moment`, test helper `seedAxes`), Task 3 (`checkValue`), `requireEntity`, `normalizeName`, `Queryable` (a client inside a transaction, READ COMMITTED).
- Produces (all take `db: Queryable`; `entity`/`property` are strings):
  - `resolveProperty(db, name: string): Promise<{ id: number; name: string; valueType: ValueType; singleValued: boolean }>` — exported (Task 6 uses it). Looks up `normalizeName(name)` (so `'Job Title'` finds `job_title`; `invalid_name` from `normalizeName` propagates); missing → `unknown_type` with `details: {name}`.
  - `addProperty(db, a: { entity: string; property: string; value: unknown; spans: Span[]; evidenceId?: bigint }): Promise<{ ids: bigint[] }>` — one row per span; no spans → one timeless row.
  - `replaceProperty(db, a: { entity: string; property: string; value: unknown; moment?: Moment; evidenceId?: bigint }): Promise<{ closed: bigint[]; retracted: bigint[]; ids: bigint[] }>` — with `moment`: close open rows on the axis at `moment.at` (R2, R6) and insert `[at,)`; `retracted` is `[]`. Without: retract all non-retracted timeless rows and insert a new timeless one; `closed` is `[]`.
  - `endProperty(db, a: { entity: string; property: string; moment: Moment; evidenceId?: bigint }): Promise<{ closed: bigint[] }>` (`evidenceId` ignored, R8)
  - `retractProperty(db, a: { id: bigint; evidenceId?: bigint }): Promise<{ id: bigint }>` — `not_found` if no row or already retracted.
  - Internal `lockProperty(db, entityId: bigint, typeId: number)` implementing R1.

Order inside `add`/`replace`/`end`: resolve entity (`unknown_entity`) and property (`unknown_type`), `checkValue` (not for `end`), lock, R3 checks (single-valued only), close/retract, insert. Rows are inserted with `value = $n::jsonb` from `JSON.stringify(value)` and `time_span = int8range($lo, $hi, '[)')` (NULL bounds allowed). A `23P01` from INSERT is caught here and rethrown as `RemoraError('single_valued_conflict', ..., {entity, property})`. Evidence ids, when given, go to `evidence_id` (insert) or `retracted_evidence_id` (retract), per R8.

- [ ] **Step 1: Write failing tests** (per-test `withDb` + `seedAxes`; build `Span`/`Moment` with `parseSpans`/`parseMoment` over the returned registry; run each service call inside `BEGIN`…`COMMIT` on a pooled client via a tiny local `inTx(pool, fn)` helper that rolls back and rethrows on error):
  - spec table: `replaceProperty` Junior at 292, Senior at 300, `endProperty` at 310 → rows (by `id`) `lower/upper` = `292/300` Junior, `300/310` Senior; second `replaceProperty` returns `closed` = [first id].
  - multi-valued `nickname`: two `addProperty` with `from` 292 and 295 coexist.
  - single-valued `addProperty` `[300,)` over existing `[292,)` → `single_valued_conflict`; same span on axis `real` succeeds.
  - R2: open row `[292,)`; `replaceProperty` at 291 → `invalid_time`; at 292 → `invalid_time` (separate test); afterwards the row is unchanged.
  - R3 (each a separate test): timeless add then timed add → `timeless_conflict`; timed add then timeless add → `timeless_conflict`; timeless add then timed `replaceProperty` → `timeless_conflict`; timed add, `endProperty`, then timeless `replaceProperty` → `timeless_conflict` (closed rows count); two timeless adds → `single_valued_conflict`; timeless `replaceProperty` twice → second returns `retracted` = [first id] and one non-retracted row remains with the new value; multi-valued `nickname` timeless + timed both succeed.
  - Retraction frees the interval (Review Focus 3): add `[292,)`, `retractProperty`, then add `[300,)` succeeds; `retractProperty` of the same id again → `not_found`; `retractProperty` with an id that does not exist → `not_found`.
  - `endProperty` with nothing open → `not_found`; `property:'nope'` → `unknown_type`; `entity:'nobody'` → `unknown_entity`; `job_title` value `5` → `value_type_mismatch`.
  - value round trip: `nickname` `"Bobby"` stored as jsonb string (`SELECT value FROM property_version` → `'Bobby'`).
  - Concurrency (Review Focus 1): committed open row `[292,)` Junior; two clients, each `BEGIN`, `replaceProperty` (at 300 / at 301), `COMMIT`, run with `Promise.all`; each outcome is either success or a `RemoraError` with code `invalid_time` (the later lock holder closing a row that now starts after its `at`) — never a raw pg error; afterwards exactly one non-retracted row with `upper(time_span) IS NULL`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/properties.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `properties.ts`.
- [ ] **Step 4: Run** test file + typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat: property write services`.

### Task 5: Relation writes

**Files:**
- Create: `packages/server/src/services/relations.ts`
- Test: `packages/server/test/relations.test.ts`

**Interfaces:**
- Consumes: Task 2 (`Span`, `Moment`, `AxisRef`, `seedAxes`), `requireEntity`, `normalizeName`, `relation_logical_id_seq` (Task 1).
- Produces:
  - `resolveRelationType(db, name: string): Promise<{ id: number; name: string; directed: boolean }>` — exported (Task 6 uses it); lookup by `normalizeName(name)`; missing → `unknown_type`.
  - `type RelationRef = { relationId: bigint } | { type: string; from: string; to: string }`
  - `addRelation(db, a: { type: string; from: string; to: string; spans: Span[]; evidenceId?: bigint }): Promise<{ relationId: bigint; ids: bigint[] }>` — `nextval('relation_logical_id_seq')` once, one row per span (none → one timeless row).
  - `endRelation(db, a: { ref: RelationRef; moment: Moment; evidenceId?: bigint }): Promise<{ closed: bigint[] }>` — closes matched rows on `moment.axis` with `upper(time_span) IS NULL` (R2 for every row, R6, R8); none → `not_found`.
  - `retractRelation(db, a: { ref: RelationRef; axis?: AxisRef; evidenceId?: bigint }): Promise<{ retracted: bigint[] }>` — all matched rows (or only rows with `time_axis = axis.id`); none → `not_found`.
  - Internal `matchRows(db, ref, extraWhere)`: `SELECT id, lower(time_span)::text AS lo ... FOR UPDATE` over non-retracted rows. Selector: resolve type and both entities first (`unknown_type`/`unknown_entity`), match `relation_type_id = $t AND ((src=$from AND dst=$to)` plus, if the type is undirected, `OR (src=$to AND dst=$from))`. `{relationId}`: `relation_id = $id`; no rows → `not_found`. `FOR UPDATE` makes a concurrent second `end_relation` re-check `upper(time_span) IS NULL` after the first commits and find nothing (`not_found`) instead of overwriting.

- [ ] **Step 1: Write failing tests** (per-test `withDb` + `seedAxes`; create entity `google` and types `works_at` (directed) and `friend_of` (undirected) with `createEntity`/`createRelationType`): `addRelation` with spans on `game_day` and `real` returns one `relationId` and two ids, both rows share `relation_id`; a second `addRelation` gets a larger `relationId`; timeless add → one row with NULL `time_axis`/`time_span`; `endRelation` by `relationId` at 306 → `upper = 306` on the `game_day` row only; `endRelation` by selector; selector with nothing matching → `not_found`; `endRelation` twice → second `not_found`; R2: `endRelation` at 292 on a row starting at 292 → `invalid_time`; **undirected** `friend_of` added `bob→google`, ended with selector `{from:'google', to:'bob'}` succeeds; for directed `works_at` the reversed selector → `not_found`; `retractRelation` without axis retracts both rows, with `axis: real` only the `real` row; two parallel `works_at` relations bob→google (two `addRelation` calls) are both closed by one selector call (`closed.length === 2`); `{relationId: 999n}` → `not_found`; unknown entity → `unknown_entity`; unknown type → `unknown_type`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/relations.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `relations.ts`.
- [ ] **Step 4: Run** test file + typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat: relation write services`.

### Task 6: Fact reads

**Files:**
- Create: `packages/server/src/services/facts-read.ts`
- Test: `packages/server/test/facts-read.test.ts`

**Interfaces:**
- Consumes: Task 2 (`When`, `AxisRef`, `formatTime`, `seedAxes`), `resolveProperty` (Task 4), `resolveRelationType` (Task 5), `requireEntity`, `clampLimit`.
- Produces:
  - `whenClause(when: When | undefined, firstParam: number): { sql: string; params: unknown[] }` — for a table with `time_axis`/`time_span`: `undefined` → `{sql: 'true', params: []}`; `at` → `(time_axis IS NULL OR (time_axis = $n AND time_span @> $m::bigint))`; `during` → `(time_axis IS NULL OR (time_axis = $n AND time_span && int8range($a, $b, '[)')))`. `$n` numbering starts at `firstParam`.
  - `interface PropertyRow { id: bigint; value: unknown; time: TimeOut | null; evidenceId: bigint | null; recordedAt: Date; retractedAt: Date | null }` (the API layer converts to numbers/ISO strings and snake_case, omitting `retracted_at` when null)
  - `propertyAt(db, registry, a: { entity: string; property: string; when: When }): Promise<PropertyRow[]>` — non-retracted, `whenClause`, order by `id`.
  - `propertyHistory(db, registry, a: { entity: string; property: string; axis?: AxisRef; includeRetracted?: boolean }): Promise<PropertyRow[]>` — axis filter per R9; `ORDER BY time_axis NULLS FIRST, lower(time_span) NULLS FIRST, id`.
  - `interface RelationRow { id: bigint; relationId: bigint; type: string; from: string; to: string; time: TimeOut | null; evidenceId: bigint | null; recordedAt: Date; retractedAt: Date | null }` (`from`/`to` are the stored `src`/`dst` keys)
  - `relationHistory(db, registry, a: { entity: string; relationTypes?: string[]; direction?: 'out' | 'in' | 'both'; when?: When; includeRetracted?: boolean; limit?: number }): Promise<{ rows: RelationRow[]; total: number; truncated: boolean }>` — `direction` default `both`; directed types: `out` → `src = e`, `in` → `dst = e`, `both` → either; undirected types always match `src = e OR dst = e` regardless of `direction`; unknown name in `relationTypes` → `unknown_type`; order by `relation_id`, `id`; `total` = count without limit.

SQL selects bounds as `lower(time_span)::text AS lo, upper(time_span)::text AS hi` and calls `formatTime`. Unknown property/relation type → `unknown_type`; unknown entity → `unknown_entity`.

- [ ] **Step 1: Write failing tests** (per-test `withDb` + `seedAxes`, data written with the Task 4–5 services inside a committed transaction): `propertyAt` at 295 → Junior, at 300 → Senior, at 310 → `[]` (after end at 310); a timeless `height` value appears for `{axis: game_day, at: 1}` and for `{axis: real, at: 1}`; a `job_title` row on `real` is not returned for a `game_day` query; `during [290,300)` → Junior only, `[299,301)` → both; multi-valued `nickname` returns two rows; `propertyHistory` hides a retracted row by default and returns it (with `retractedAt` set) when `includeRetracted`; `axis: game_day` filter returns `game_day` and timeless rows only; `relationHistory` for directed `works_at` bob→google: from `bob` `out` → 1, `in` → 0; from `google` `in` → 1; undirected `friend_of` bob→google from `google` with `direction: 'out'` → 1; `relationTypes: ['friend_of']` filter; `relationTypes: ['nope']` → `unknown_type`; three relations with `limit: 2` → `rows.length 2, total 3, truncated true`; **big values** (Review Focus 4): `addProperty` on axis `big` with `from {v:'9007199254740993'}` → `propertyHistory` returns `time` deep-equal `{axis:'big', from:{v:'9007199254740993'}}` and the stored `lower(time_span)::text` is `'9007199254740993'`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/facts-read.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `facts-read.ts`.
- [ ] **Step 4: Run** test file + typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat: fact read services`.

### Task 7: `apply` engine

**Files:**
- Create: `packages/server/src/api/apply.ts`, `packages/server/src/api/args.ts`
- Test: `packages/server/test/apply.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5, `createEntity`, `createRelationType`, `createPropertyType` (pass the transaction client, so `withNameLock` runs inside the batch transaction), `PluginRegistry`, `pg.Pool`, `ErrorCode`.
- Produces:
  - `type ApiError = { op_index: number; code: ErrorCode; message: string; details?: Record<string, unknown> }`
  - `type ApplyResponse = { ok: true; results: unknown[] } | { ok: false; error: ApiError }`
  - `apply(pool: pg.Pool, registry: PluginRegistry, request: unknown): Promise<ApplyResponse>`
  - `mapPgError(e: unknown): RemoraError | null` — exported (Task 8 reuses it): SQLSTATE `23P01` → `single_valued_conflict`, `40001`/`40P01` → `concurrent_update`, `23503` → `invalid_param`; anything else → `null`.
  - `args.ts` helpers: `str(o, key)`, `optStr(o, key)`, `bool(o, key)`, `optBool(o, key)`, `int(o, key)`, `optInt(o, key)`, `obj(o, key)`, `optStrArr(o, key)` — throw `RemoraError('invalid_param', ..., {field: key})` on a missing or wrongly typed field.

Behaviour: request must be a plain object `{ops: object[]}` with ≥1 op, else `{ok:false, error:{op_index:-1, code:'invalid_param', ...}}`. One `pool.connect()` client: `BEGIN` (READ COMMITTED), ops in order, `COMMIT`. A thrown `RemoraError`, or a pg error that `mapPgError` maps, → `ROLLBACK` and `{ok:false, error}` with the failing op's index. Any other error → `ROLLBACK` and rethrow. Always `release()` the client. Dispatcher table keyed by `op` (R5 for unknown names). Ops, fields and results exactly:

| op | fields | result |
|---|---|---|
| `create_entity` | `key` | `{key, created}` |
| `create_relation_type` | `name, description, directed` | `{id, name, description, directed}` |
| `create_property_type` | `name, description, value_type, single_valued` | `{id, name, description, value_type, single_valued}` |
| `add_property` | `entity, property, value, time?, evidence?` | `{ids}` |
| `replace_property` | `entity, property, value, time?, evidence?` (`time` = `{axis, at}`; absent = timeless form) | `{closed, retracted, ids}` |
| `end_property` | `entity, property, time, evidence?` | `{closed}` |
| `retract_property` | `id, evidence?` | `{id}` |
| `add_relation` | `type, from, to, time?, evidence?` | `{relation_id, ids}` |
| `end_relation` | (`relation_id`) xor (`type`, `from`, `to`), `time`, `evidence?` | `{closed}` |
| `retract_relation` | (`relation_id`) xor (`type`, `from`, `to`), `axis?` (axis name), `evidence?` | `{retracted}` |

`value` is required (`undefined` → `invalid_param`; JSON `null` is a value). `end_relation`/`retract_relation` with both forms, neither, or a partial selector → `invalid_param`. Unknown extra fields are ignored. Any op may carry `as` (R4); results of such ops gain `as`. Result bigints are converted to numbers.

- [ ] **Step 1: Write failing tests** (per-test `withDb` + `seedAxes`; `seedBasics` already provides `bob`, `job_title`, `nickname`, `height`, axes `game_day`/`real`):
  - spec example batch (without `add_evidence`): `create_entity bob` (→ `{key:'bob', created:false}`), `create_entity google` (`created:true`), `create_relation_type works_at` (directed), `replace_property bob job_title Junior {axis:'game_day', at:292}` (→ `{closed:[], retracted:[], ids:[<number>]}`), `add_relation works_at bob→google {axis:'game_day', from:292}` (→ `relation_id` number, one id) → `ok:true`, four results in order.
  - local names: `create_entity` with `as:'c'` then `add_property` with `entity:'$c'` works and the first result has `as:'c'`; `$missing` → `unknown_ref` with `op_index` of the referencing op; reference to a name declared by a later op → `unknown_ref`; duplicate `as` → `invalid_param` at the second op; `$c` bound to `create_entity` used as `evidence` → `unknown_ref`; numeric `evidence: 999` → `unknown_ref`; `evidence: 'x'` (no `$`) → `invalid_param`; `create_entity` with `key: '$x'` → `invalid_name`.
  - evidence stored: insert an `evidence_source` (plugin = seeded `test` plugin) and an `evidence_log` row by SQL; `add_property` with that numeric `evidence` → row has that `evidence_id`; `retract_property` with it → `retracted_evidence_id` set.
  - atomicity (Review Focus 2): batch `[create_entity x, add_property on property 'nope']` → `ok:false`, `op_index: 1`, `unknown_type`; entity `x` does not exist afterwards.
  - each op sees earlier ops' results: `replace_property` at 292 then `end_property` at 300 in one batch → `end_property` result `closed` equals the replace result `ids`.
  - correction in one batch: `retract_property id` + `add_property` with the same span → `ok:true`.
  - `invalid_param` for: unknown op `'frobnicate'` (`details.op`), `add_evidence` (deferred), missing `entity`, `directed: 'yes'`, `end_relation` with both `relation_id` and selector, empty `ops`, `ops` not an array, body `null` (the last three with `op_index: -1`).
  - pg error mapping: `mapPgError({code:'23P01'})` → `single_valued_conflict`, `{code:'40P01'}` → `concurrent_update`, `{code:'42P01'}` → `null`.
  - concurrency (Review Focus 1): committed `replace_property` Junior at 292; two `apply` calls in parallel replacing `job_title` at 300 and at 301 → each response is `ok:true` or `ok:false` with code `invalid_time`; final DB has exactly one non-retracted row with `upper(time_span) IS NULL`.
  - idempotent replay: the same `[create_entity carl]` batch applied twice → both `ok:true`, second result `created:false`.
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
- Consumes: Tasks 6–7 (`mapPgError`, `ApiError`, `args.ts`), `parseWhen`, `getEntity`, `findEntities`, `listRelationTypes`, `listPropertyTypes`, `findRelationTypes`, `findPropertyTypes`, `listTimeAxes`.
- Produces:
  - `type QueryResponse = { ok: true; results: unknown[] } | { ok: false; error: ApiError }`
  - `query(pool: pg.Pool, registry: PluginRegistry, request: unknown): Promise<QueryResponse>` — `{ops:[...]}` (same envelope/validation as `apply`, `op_index: -1` for a bad body); runs in one `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction ended with `ROLLBACK`; errors handled as in `apply`. `as`/`$name` are not supported in `query` (`as` is ignored).
  - Ops and results (all snake_case):
    - `get_entity{key}` → `{key}`; `unknown_entity` if missing.
    - `find_entities{query, limit?}` → `{rows: [{key}], total, truncated}`.
    - `property_at{entity, property, when}` (`when` required, else `invalid_param`) → `{rows}`.
    - `property_history{entity, property, axis?, include_retracted?}` → `{rows}`.
    - `relation_history{entity, relation_types?, direction?, when?, include_retracted?, limit?}` → `{rows, total, truncated}`; `direction` outside `out|in|both` → `invalid_param`.
    - Property row: `{id, value, time, evidence_id, recorded_at, retracted_at?}`; relation row: `{id, relation_id, type, from, to, time, evidence_id, recorded_at, retracted_at?}`; `time` is `TimeOut` or `null`; timestamps ISO strings; `retracted_at` present only when set.
    - `list_relation_types`, `find_relation_types{query}` → `{rows: [{id, name, description, directed}]}`; `list_property_types`, `find_property_types{query}` → `{rows: [{id, name, description, value_type, single_valued}]}`; `list_time_axes` → `{rows: [{name, description, value_schema, example}]}`.
    - `neighbors`, `get_event`, `search_events`, `entity_events`, `list_event_roles`, `list_evidence_sources`, `get_evidence` → `invalid_param` until plan 3.
  - `RemoraApp` gains `apply(request: unknown): Promise<ApplyResponse>` and `query(request: unknown): Promise<QueryResponse>` bound to its pool and registry; `index.ts` exports `apply`, `query`, `ApplyResponse`, `QueryResponse`, `ApiError`.

- [ ] **Step 1: Write failing tests.** `query.test.ts` (per-test `withDb` + `seedAxes`, data written through `apply`): each op through `query` with the row shapes above; `property_at` without `when` → `invalid_param`; `when: {axis:'nope', at:1}` → `unknown_axis`; `when: {axis:'game_day', at:-1}` → `invalid_time`; `when: {axis:'game_day'}` → `invalid_param`; `find_entities` with `limit: 500` is clamped (returns ≤ 200, no error) and `limit: 0` → `invalid_param`; a failing second op reports `op_index: 1`. `facts-e2e.test.ts` uses `startRemora({databaseUrl, importer})` with the same fake importer as `test/app.test.ts` (returns the bundled `@remora/core-plugin`); core defaults provide `game_day` (integer), `real` (datetime, seconds, ISO strings with zone) and `story` (packed). Replay the spec scenarios through `app.apply` / `app.query`: Bob's job history (`Junior` at 292 → `Senior` at 300 → ended at 310) via `property_history`; nicknames `Bobby`/`Rob`; `works_at` bob→google on `game_day` `{from:292, to:306}` and `real` `{from:'2026-10-01T00:00:00Z', to:'2026-10-20T00:00:00Z'}` in one `add_relation` with a shared `relation_id` — stored `lower(time_span)` on `real` is `1790812800`, and `relation_history` returns `time` `{axis:'real', from:'2026-10-01T00:00:00.000Z', to:'2026-10-20T00:00:00.000Z'}` (decode uses `toISOString`); `end_relation` by selector; a `story` value `{tome:10, chapter:5}` round-trips as `{tome:10, chapter:5, scene:0}`; correction by `retract_property` + `add_property` in one batch; `property_history` with `include_retracted: true` shows the retracted row.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/query.test.ts packages/server/test/facts-e2e.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `query.ts`; wire `apply`/`query` into `startRemora` and export from `index.ts`.
- [ ] **Step 4: Run** the full suite `npm test` and `npm run typecheck`; expect all green.
- [ ] **Step 5: Commit** `feat: query engine and app wiring for facts`.

---

## Parked for plan 4 (carry-over)

Advisory lock around migrations and core registration; static import of core plugin; smoke test of `startRemora` without the fake importer; plugin name vs row name check; `close()` idempotence; JSON Schema contract for `apply`/`query` (hand validators in `api/args.ts` become generated from it).
