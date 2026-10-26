# Remora Graph, Events, Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `neighbors` traversal, events (write + search) and evidence (ingest, read, retention, purge, pin) as in-process service functions exposed through the existing `apply` / `query` engines and, for operator-only evidence maintenance, as methods on `RemoraApp`.

**Architecture:** Same layering as plan 2: service modules in `packages/server/src/services/` take a `Queryable` (or a `pg.Pool` for multi-transaction maintenance), use camelCase, `bigint` ids and `Date`; `api/apply.ts` and `api/query.ts` dispatch ops, validate arguments with `api/args.ts`, and convert results to snake_case / numbers / ISO strings. `neighbors` computes reachable entities with a level-by-level recursive CTE (`UNION` over `(entity_id, depth)`) and then ranks, decorates (`via`, `properties`) and limits them; `paths: true` enumerates simple paths with an early-stopping `LIMIT 10001`. Evidence sources are looked up in the plugin registry; the core plugin gains declarative evidence sources (keep list + age-based retention stages).

**Tech Stack:** Node.js/TypeScript (ESM, NodeNext), PostgreSQL 18 via `pg`, `ajv` (shared instance in `services/ajv.ts`), vitest + testcontainers (`createTestDb`, `seedBasics`, `seedAxes`, `startRemora`).

**Spec:** `docs/superpowers/specs/2026-10-22-historicity-design.md` — sections 10.2, 10.3 (`neighbors`), 11 (events), 12 (evidence), 13 (core plugin evidence sources), 15 open questions 3–4. Plans 1–2 (`2026-10-26-remora-foundation.md`, `2026-10-26-remora-facts.md`) are merged on `master`; their Global Constraints and Rulings R0–R10 still hold. Plan 4 adds HTTP/MCP, the JSON Schema contract and the admin API; nothing here is exposed over a transport.

**Execution:** Sonnet implementers and Opus reviewers via subagent-driven-development in the worktree `D:\AIWorkspace\remora-wt-p3` (branch `feat/graph-events-evidence`, `node_modules` already installed). Each task is self-contained: read the files it lists plus `src/api/apply.ts`, `src/api/query.ts`, `src/services/time.ts` before starting.

## Global Constraints

- Code, identifiers, error messages: English. Tests assert on `RemoraError.code` (and `details` where stated), never on message text.
- Error codes only from `ErrorCode` in `@remora/sdk`; no new codes. Every spec ambiguity is settled by a Ruling below.
- Service layer: camelCase fields, `bigint` row ids, `Date` timestamps. API layer (`apply.ts`/`query.ts`): snake_case, ids as JSON numbers (`Number(bigint)`), timestamps as ISO strings, times as plugin-decoded axis values. `query.ts` maps rows field by field (payloads, values and schemas are user/plugin data and must never pass through the key-renaming `toApi`); `apply.ts` results go through `toApi` as today.
- All writes of one `apply` batch go through the batch's single transaction client (`env.db`), at READ COMMITTED (R1 of plan 2). `query` runs in `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`. Maintenance functions (`applyRetention`, `purgeEvidence`) open their own READ COMMITTED transactions on the pool.
- One client never has two queries in flight: no `Promise.all` over the same client; run queries sequentially.
- All SQL parameterised; `jsonb` parameters are `JSON.stringify(x)` with `$n::jsonb`; bigint arrays are sent as `string[]` with `$n::bigint[]`; bigint columns come back as strings → `BigInt(x)`.
- `limit` defaults to 50, max 200 via `clampLimit` (`src/sql/like.ts`); every limited read returns `total` and `truncated`.
- Time predicates reuse `whenClause` from `services/facts-read.ts` for tables with `time_axis`/`time_span` (it emits unqualified column names: only use it where those names are unambiguous).
- Schema: `migrations/001_init.sql` already has `event`, `event_time`, `event_entity`, `evidence_source`, `evidence_log` exactly as spec 11–12. **No new migration in this plan.**
- Tests: one fresh DB per test via a local `withDb` (`createTestDb` → `runMigrations` → `seedBasics` → `seedAxes` → `drop`), like `test/apply.test.ts`. No shared state. Run a single file with `npx vitest run packages/server/test/<file>.test.ts`; full suite `npm test`; types `npm run typecheck` (both from the repo root).
- Commits: add files by name (never `git add -A`); end each message with the implementer's own line, e.g. `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Rulings (spec gaps and deviations; numbering continues plan 2's R0–R10)

- **R11 traversal.** Reachability = recursive CTE over rows `(entity_id, depth)` combined with `UNION`, seeded with `(start, 0)`, stepping while `depth < $depth`; an entity's depth is `min(depth)`. The start entity never appears in `rows`, even when a cycle reaches it. Edge sets: `outTypes` = undirected types ∪ (directed types if `direction ∈ {out, both}`); `inTypes` = undirected types ∪ (directed types if `direction ∈ {in, both}`); a step follows `src→dst` for `relation_type_id = ANY(outTypes)` and `dst→src` for `ANY(inTypes)` (two `UNION ALL` branches inside a `CROSS JOIN LATERAL`, verified on PG 18.6). `relation_types` omitted = all types; given but empty → `invalid_param`. `direction` default `both`. `depth` default 1, integer 1–6, else `invalid_param`. Every step excludes retracted rows and applies `whenClause(when)` (timeless edges always pass).
- **R12 via.** For an entity at depth d, the qualifying edges are those (same type/direction/time filter) from any entity whose min depth is d−1. `via` = the edge with the smallest `(relation_id, id)`: `{relation, from: <predecessor key>, relation_id, time}`; `via_count` = number of distinct `relation_id` among qualifying edges (a relation stored on two axes counts once; parallel relations and different predecessors each count).
- **R13 include / order_by.** Property values are taken like `propertyAt`: non-retracted, `whenClause(when)` (all non-retracted values when `when` is absent), ordered by `id`. `properties` is keyed by the canonical type name (`resolveProperty().name`), always present for each included name (`[]` when none), and absent entirely when `include` is not given. `order_by: {property, dir}` (`dir` default `asc`; else `invalid_param`; property need not be in `include`): sort key is the greatest value for `desc`, the least for `asc`, using jsonb ordering (`ORDER BY value DESC|ASC LIMIT 1` subquery — PG has no `max(jsonb)`); entities without a value sort last; ties by `depth`, then `key`. Without `order_by`: `depth`, then `key`. Sorting happens over all reachable entities before `limit`.
- **R14 paths.** `paths: true` enumerates simple paths (no entity repeated, start never revisited) of length 1..depth with the same step filters; one step per relation **row** (deviation: a relation stored on two axes and queried without `when` yields two paths). The path query ends `LIMIT 10001` without `ORDER BY` (PG stops the recursion early); 10 001 rows → `too_many_paths` with `details: {limit: 10000}`. The cap counts all paths before entity ranking/limit. Each row: `{entity, depth, paths}` where `depth` = shortest path length and `paths` = list of paths (shortest first, then by relation row ids), each a list of steps `{relation, from, to, relation_id, time}` with `from`/`to` in traversal order. No `via`/`via_count` in this mode; `include`, `order_by`, `limit`, `total`, `truncated` work as in R13 (over entities).
- **R15 source registry.** `getSource(name)`: served by a loaded plugin → `SourceInfo`; row exists in `evidence_source` but not served (plugin failed, or no longer declares it) → `source_unavailable`; no row → `unknown_source`. `listSources()` = served sources ordered by id. `payloadSchema` is compiled at load (`compileCached`); failure → `invalid_plugin` for that plugin, like `valueSchema`.
- **R16 add_evidence.** ajv-validate `payload` (required; `undefined` → `invalid_param`) against `def.payloadSchema` → `invalid_payload` with `details: {source, reason}`; then `def.ingest(payload)`: a thrown `RemoraError` passes through, any other throw → `invalid_payload` (`reason` = message); a result that is not an object with a defined `payload` → `invalid_plugin`. Store `payload` and `retention_state` (`NULL` when `retentionState` is undefined). Result `{id}`. `$name` bound to `add_evidence` resolves to its `id` (the `EVIDENCE_OPS` set in `apply.ts`).
- **R17 core-plugin sources.** `CoreConfig.evidenceSources?: SourceConfig[]`, `SourceConfig = {name, description?, schema, keep?: string[], retention?: {after: string, drop: string[] | '*'}[]}`. `after` matches `^(\d+) (minute|hour|day)s?$`; stages must have strictly increasing `after`; `schema` must be an object; violations → `invalid_config` from `setup`. `ingest`: object payload with `keep` → only the listed keys that are present; otherwise the payload unchanged; `retentionState: {stage: 0}`. `planRetention(rows, now)`: `target` = number of stages with `after ≤ now − createdAt`; `cur` = `retentionState.stage` (0 when missing); `target ≤ cur` → `keep`; otherwise if any stage in `cur..target−1` drops `'*'` → `purge`, else `replace` with the union of dropped keys removed (non-object payloads unchanged) and `retentionState {stage: target}`. Default config adds one source `chat_message` (schema: object with string `text` required, optional strings `sender`, `sent_at`; `keep: ['text','sender','sent_at']`; no retention stages) — deviation: spec 13 shows `telegram_message` only as an example; a default source makes the spec 10.1 example batch work out of the box. `description` default: `Evidence source <name>.`
- **R18 apply_retention.** Batches of 500 rows (`batchSize` 1–10 000, else `invalid_param`), keyset `id > $last ORDER BY id LIMIT $batch FOR UPDATE`, rows `NOT pinned AND purged_at IS NULL` of one source; one transaction per batch (deviation: spec says "in a transaction" — a failure leaves earlier batches committed, which is safe because the operation is idempotent). Actions are validated before any write: id not in the batch, duplicate id, unknown `action`, or `replace` without `payload` → `invalid_plugin` (batch rolled back, error thrown); rows without an action are kept; a non-`RemoraError` throw from `planRetention` → `invalid_plugin`. `purge` sets `payload = NULL, retention_state = NULL, purged_at = now()`. No `source` → all served sources in id order, names of `evidence_source` rows not served go to `skipped`; explicit source → R15 errors. `now` defaults to `new Date()`.
- **R19 purge_evidence.** `{ids}` (non-empty) or `{source, olderThan}` (source looked up in `evidence_source` by name, so purge works while the plugin is down; missing → `unknown_source`). Pinned rows are never purged (deviation/precision: spec says pin protects from the retention policy; manual purge also respects it — unpin first) and are counted in `skippedPinned`; already purged rows are no-ops. `{ids}` with any id absent from `evidence_log` → `not_found` (`details: {ids: [...missing]}`), nothing purged. Updates run in batches of 1 000 ids, one transaction per batch. Result `{purged, skippedPinned}` (counts).
- **R20 pin/unpin.** Idempotent; unknown id → `not_found`; pinning a purged row is allowed.
- **R21 evidence reads.** `get_evidence{id}` → `{id, source, payload, created_at, purged_at, pinned}` (`payload` = remaining payload or `null`; `purged_at` ISO or `null`; `retention_state` is plugin-private and not returned); missing → `not_found`. `list_evidence_sources` → `{rows: [{name, description, payload_schema}]}` from the `evidence_source` table ordered by id (like `list_time_axes`).
- **R22 event time.** `time` on `add_event` is required: an object or non-empty array; each item is `{axis, at}` (instant: `[at, at+1)`, `instant = true`) or `{axis, from?, to?}` (`instant = false`, both bounds optional). `at` mixed with `from`/`to` → `invalid_param`; duplicate axis → `invalid_param`; `from >= to` → `invalid_time`; `at` encoding to `2^63−1` (no room for `at+1`) → `invalid_time`. Output: instant → `{axis, at}`, otherwise `{axis, from?, to?}`; ordered by axis id.
- **R23 normalisation.** Keywords: `NFC`, trim, lowercase, de-duplicated keeping first occurrence; an empty keyword → `invalid_param`. Roles: `normalizeName` (so `'Eye Witness'` → `eye_witness`; empty → `invalid_name`), default `participant`. Duplicate `(entity, role)` pairs collapse. `summary` must be non-empty after trim, else `invalid_param`; `details` optional string.
- **R24 update_event.** `id` plus at least one of `summary`, `details` (`null` clears), `keywords` (`{set: [...]}` or `{add?, remove?}`; mixing → `invalid_param`), `time` (same shape as `add_event`; each given axis is upserted, axes not mentioned are kept; no way to remove an axis in v1), `entities` (`{add?: [{entity, role?}], remove?: [{entity, role?}]}`; adding an existing pair is a no-op; `remove` without `role` removes all roles of that entity; removing a pair/entity that is not attached → `not_found`), `evidence` (replaces `evidence_id`); otherwise `invalid_param`. Sets `updated_at = now()`. Missing or retracted event → `not_found`. `retract_event{id, evidence?}`: sets `retracted_at`, `retracted_evidence_id`; missing or already retracted → `not_found`. Event ids are numeric only (no `$name`).
- **R25 event search.** `text`: split into words (`wordPatterns`), each must occur (`ILIKE`) in exactly `(summary || ' ' || coalesce(details, ''))` — the indexed expression (deviation: spec says "substring"; per-word matching matches `find_entities`; a one-word query is a plain substring). `keywords` (non-empty array) normalised per R23: `match: 'any'` (default) → `keywords && $k`, `'all'` → `keywords @> $k`, other → `invalid_param`. `entities`: the event must involve **all** listed entities (any role); unknown → `unknown_entity`. `when`: `EXISTS` an `event_time` row on that axis with `time_span @> at` / `&& [a,b)`. Order: with `when`, `lower(time_span)` on that axis `DESC NULLS LAST`, then `id DESC`; without `when`, `id DESC` (deviation: there is no common axis to compare across). No criteria = newest events. Retracted events are excluded from search/`entity_events`/`list_event_roles`; `get_event` returns them with `retracted_at`. Event row: `{id, summary, details, keywords, time, entities: [{entity, role}] (by key, role), evidence_id, recorded_at, updated_at, retracted_at?}` (`details`, `evidence_id`, `updated_at` are `null` when unset; `retracted_at` present only when set). `list_event_roles` → `{roles: [...]}` distinct, sorted.
- **R26 maintenance surface.** `applyRetention`, `purgeEvidence`, `pinEvidence`, `unpinEvidence` are exported service functions and `RemoraApp` methods; they throw `RemoraError` (no `{ok}` envelope; plan 4 maps them to HTTP).

## Review Focus

1. A cycle back to the start entity (or between neighbours) must neither list the start entity nor inflate depth/duplicate rows. (Task 1)
2. Parallel relations and one relation stored on two axes collapse to one row; `via_count` counts logical relations. (Task 1)
3. A hub with more than 10 000 paths under `paths: true` returns `too_many_paths` quickly instead of hanging or truncating silently; exactly 10 000 is allowed. (Task 2)
4. A misbehaving retention plugin (foreign id, malformed action, throw) leaves the batch untouched and reports `invalid_plugin`; pinned rows are never passed to the plugin. (Task 6)
5. Facts and events whose evidence was purged stay readable: `evidence_id` is still reported and `get_evidence` returns `payload: null` with `purged_at`. (Task 6, Task 9)

---

### Task 1: `neighbors` — level traversal, via, include, order_by

**Files:**
- Create: `packages/server/src/services/neighbors.ts`
- Modify: `packages/server/src/api/query.ts` (op `neighbors`), `packages/server/test/query.test.ts` (drop `'neighbors'` from the deferred-ops list)
- Test: `packages/server/test/neighbors.test.ts`

**Interfaces:**
- Consumes: `whenClause` (`facts-read.ts`), `formatTime`, `When`, `TimeOut` (`time.ts`), `resolveRelationType`, `resolveProperty`, `requireEntity`, `clampLimit`.
- Produces:
  - `type Direction = 'out' | 'in' | 'both'`
  - `interface NeighborsArgs { entity: string; relationTypes?: string[]; direction?: Direction; depth?: number; when?: When; include?: string[]; orderBy?: { property: string; dir?: 'asc' | 'desc' }; limit?: number; paths?: boolean }`
  - `interface NeighborStep { relation: string; from: string; to: string; relationId: bigint; time: TimeOut | null }`
  - `interface NeighborRow { entity: string; depth: number; via?: Omit<NeighborStep, 'to'>; viaCount?: number; paths?: NeighborStep[][]; properties?: Record<string, unknown[]> }`
  - `neighbors(db: Queryable, registry: PluginRegistry, a: NeighborsArgs): Promise<{ rows: NeighborRow[]; total: number; truncated: boolean }>` (`paths: true` → `invalid_param` until Task 2)
  - query op `neighbors{entity, relation_types?, direction?, depth?, when?, include?, order_by?, limit?, paths?}` → `{rows: [{entity, depth, via: {relation, from, relation_id, time}, via_count, properties?}], total, truncated}`.

Structure (R11–R13), all queries sequential on `db`:
1. `levels`: one recursive CTE returning `SELECT entity_id, min(depth) FROM reach GROUP BY entity_id` (includes the start at 0). Params: `$1` start, `$2` outTypes `smallint[]`, `$3` inTypes `smallint[]`, `$4` depth, then `whenClause(when, 5)`; the same `whenClause` text is reused in both LATERAL branches.
2. `total` = levels minus start (TS). Rank: `unnest($ids::bigint[], $depths::int[]) t(entity_id, depth) JOIN entity` + optional LATERAL sort-key subquery on `property_version`, `ORDER BY sk DESC|ASC NULLS LAST, depth, key LIMIT $limit`.
3. `via` for the page: predecessor table `unnest(<all level ids>, <all level depths>) pl(entity_id, depth)`, LATERAL per page entity aggregating qualifying edges with `pl.depth = t.depth - 1`: `(array_agg(rel.id ORDER BY rel.relation_id, rel.id))[1]`, the matching predecessor id, `count(DISTINCT rel.relation_id)`; then join `relation`, `relation_type`, `entity` for the chosen edge. Edge predicate: `(rel.src = pl.entity_id AND rel.dst = t.entity_id AND rel.relation_type_id = ANY(outTypes)) OR (rel.dst = pl.entity_id AND rel.src = t.entity_id AND rel.relation_type_id = ANY(inTypes))`, plus `retracted_at IS NULL` and the when clause (qualify via a subselect so `time_axis` stays unambiguous).
4. `properties` for the page (one query over `entity_id = ANY(page) AND property_type_id = ANY(included)`).

- [ ] **Step 1: Write failing tests.** Fixture per test (via `apply`, axis `game_day`): types `friend_of` (undirected), `works_at`, `knows` (directed); entities `carl, dave, erin, google, acme`; `friend_of` bob–carl `{from:100}` and a second, timeless `friend_of` bob–carl; `friend_of` carl–dave `{from:100, to:200}`; `knows` dave→bob (timeless); `knows` erin→bob (timeless); `works_at` bob→google (timeless); `works_at` bob→acme on `game_day {from:1}` and `real {from:1}` in one `add_relation`; `height`: carl 186, dave 190, erin 170. Tests:
  - depth 1, defaults → entities `['acme','carl','dave','erin','google']` all `depth: 1`, `total 5`, `truncated false`; bob absent.
  - `direction:'out'` → `acme, carl, google`; `'in'` → `carl, dave, erin`.
  - cycle (Review Focus 1): `relation_types:['friend_of','knows']`, `direction:'out'`, depth 3 → `carl` depth 1, `dave` depth 2; bob absent; no duplicate rows.
  - `when {game_day, at:250}`, `friend_of`, depth 2 → only `carl`; `at:150` → `carl`, `dave`; `when {real, at:5}`, `friend_of` → `carl` via the timeless relation (`via.time === null`).
  - via (Review Focus 2): `carl` has `via_count 2`, `via.from 'bob'`, `via.relation_id` = the smaller of the two `friend_of` relation ids, `via.time` deep-equals `{axis:'game_day', from:100}`; `acme` has `via_count 1`.
  - a retracted relation (`retract_relation` works_at bob→google) removes `google`.
  - `include:['height']` → carl `{height:[186]}`, google `{height:[]}`; without `include` the row has no `properties` key.
  - `order_by {property:'height', dir:'desc'}`, `limit 1` → `[dave]`, `total 5`, `truncated true`; `dir:'asc'` → `erin` first and `google`/`acme` last.
  - errors: `depth` 0, 7, 1.5 → `invalid_param`; `relation_types: []` → `invalid_param`; `['nope']` → `unknown_type`; `include:['nope']` → `unknown_type`; `entity:'nobody'` → `unknown_entity`; `limit: 0` → `invalid_param`; `limit: 500` → no error; `direction:'up'` → `invalid_param`; `order_by {property:'height', dir:'up'}` → `invalid_param`.
  - through `query()`: one `neighbors` op returns the snake_case shape above.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/neighbors.test.ts`; expect FAIL (module missing).
- [ ] **Step 3: Implement** `neighbors.ts` and the `neighbors` handler in `query.ts` (argument validation in the handler with `args.ts`; `order_by` must be an object).
- [ ] **Step 4: Run** the test file, `packages/server/test/query.test.ts` and `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `src/services/neighbors.ts`, `src/api/query.ts`, `test/neighbors.test.ts`, `test/query.test.ts`: `feat: neighbors traversal`.

### Task 2: `neighbors` with `paths: true`

**Files:**
- Modify: `packages/server/src/services/neighbors.ts`, `packages/server/src/api/query.ts` (path rows)
- Test: `packages/server/test/neighbors.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 internals (type sets, rank step, properties step).
- Produces: `export const MAX_PATHS = 10_000`; `neighbors(..., {paths: true})` per R14; API row `{entity, depth, paths: [[{relation, from, to, relation_id, time}]], properties?}`.

Path CTE columns: `(entity_id, depth, nodes bigint[], rels bigint[])`, step via the same two-branch LATERAL with `NOT n.next = ANY(p.nodes)`; outer `SELECT ... WHERE depth > 0 LIMIT 10001`. Group paths by last node in TS, rank entities with Task 1's rank step (depth = shortest path), then load the relation rows and entity keys referenced by the page's paths in two queries.

- [ ] **Step 1: Write failing tests** (Task 1 fixture): `relation_types:['friend_of']`, depth 2, `paths:true` → `carl` has 2 one-step paths (`[{relation:'friend_of', from:'bob', to:'carl', ...}]`, one per parallel relation), `dave` has 2 two-step paths whose second step is `{from:'carl', to:'dave'}`; rows have no `via`. Undirected reverse traversal: from `dave`, depth 1, step is `{from:'dave', to:'carl'}`. `limit:1`, `order_by height desc`, depth 2 → one row `dave`, `total 2`. Hub (Review Focus 3, data inserted by SQL with `generate_series` for speed): `hub` → 100 entities `m*` (`knows`), each `m*` → the same 99 entities `l*` → `paths:true`, depth 2 succeeds (exactly 10 000 paths); one more leaf (100) → `too_many_paths` with `details.limit === 10000`; `paths:false` on the same graph succeeds with `total 200`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/neighbors.test.ts`; expect the new tests to FAIL.
- [ ] **Step 3: Implement** the paths branch.
- [ ] **Step 4: Run** the test file + `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: neighbors paths mode with too_many_paths cap`.

### Task 3: Evidence source lookup in the registry

**Files:**
- Modify: `packages/server/src/plugins/registry.ts`, `packages/server/test/helpers/axes.ts`
- Test: `packages/server/test/registry.test.ts` (extend)

**Interfaces:**
- Consumes: `EvidenceSourceDef` (`@remora/sdk`), `compileCached`.
- Produces:
  - `export interface SourceInfo { id: number; name: string; def: EvidenceSourceDef }`
  - `PluginRegistry.getSource(name: string): SourceInfo` and `PluginRegistry.listSources(): SourceInfo[]` (R15). The `evidence_source` upsert gains `RETURNING id`; after the plugin loop read `SELECT id, name FROM evidence_source` to find unserved names.
  - `validateSetupResult` compiles each `payloadSchema` (bad schema → `invalid_plugin`).
  - Test helpers: `fakeSource(name: string, over?: Partial<EvidenceSourceDef>): EvidenceSourceDef` (`payloadSchema {type:'object', properties:{text:{type:'string'}}, required:['text']}`, `ingest: (p) => ({payload: p})`, `planRetention: () => []`); `fakeRegistry(axes, sources: {id: number; def: EvidenceSourceDef}[] = [], unavailableSources: string[] = [])`; `seedAxes(db, s, sources: EvidenceSourceDef[] = [], unavailableSources: string[] = [])` inserts an `evidence_source` row (plugin `test`) for every source and unavailable name and passes them to `fakeRegistry`.

- [ ] **Step 1: Write failing tests** in `registry.test.ts`: after loading a plugin with source `chat`, `getSource('chat')` has `name 'chat'`, `id` equal to the `evidence_source` row id, and `def.ingest` callable; `listSources().map(s => s.name)` → `['chat']`; `getSource('nope')` → `unknown_source`; a failing non-core plugin whose source `bad_src` row already exists → `getSource('bad_src')` → `source_unavailable`; a plugin that declared `old_src` on a first load and not on a second → `source_unavailable`; `payloadSchema: {type: 'nope'}` → that plugin's status `ok: false` with `invalid_plugin`. Add the `'source with uncompilable payloadSchema'` case to the existing malformed-setup table.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/registry.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** registry changes and the helpers.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` (every `PluginRegistry` implementation must compile); expect PASS.
- [ ] **Step 5: Commit** `feat: evidence source lookup in plugin registry`.

### Task 4: Core plugin evidence sources

**Files:**
- Create: `packages/core-plugin/src/sources.ts`
- Modify: `packages/core-plugin/src/config.ts` (`evidenceSources` in `CoreConfig`, `configSchema.properties`, `defaultConfig`), `packages/core-plugin/src/index.ts` (`setup` returns `evidenceSources: (config.evidenceSources ?? []).map(buildSource)`; export `buildSource`, `SourceConfig`)
- Test: `packages/core-plugin/test/sources.test.ts`

**Interfaces:**
- Consumes: `EvidenceSourceDef`, `RetentionRow`, `RetentionAction`, `RemoraError` (`@remora/sdk`).
- Produces: `type SourceConfig` and `buildSource(cfg: SourceConfig): EvidenceSourceDef` per R17. `configSchema` keeps `required: ['timeAxes']` (stored configs without `evidenceSources` stay valid).

- [ ] **Step 1: Write failing tests** with `src = buildSource({name:'tg', schema:{type:'object'}, keep:['text','sender','attachments'], retention:[{after:'30 days', drop:['attachments']},{after:'365 days', drop:'*'}]})`, `day = 86_400_000`, `now = new Date('2027-01-01T00:00:00Z')`, rows built with `createdAt = new Date(now.getTime() - n*day)`:
  - `ingest({text:'hi', sender:'a', extra:1})` → `{payload:{text:'hi', sender:'a'}, retentionState:{stage:0}}`; without `keep` the payload is returned unchanged.
  - `planRetention`: age 10 days stage 0 → `keep`; 40 days stage 0 → `{action:'replace', payload:{text:'hi'}, retentionState:{stage:1}}` (attachments dropped); 40 days stage 1 → `keep`; 400 days stage 0 → `purge`; 400 days stage 1 → `purge`; `retentionState: null` treated as stage 0; non-object payload `'x'` at 40 days → `replace` with payload `'x'`, stage 1.
  - `invalid_config` for: missing `schema`; `after:'30 weeks'`; stages `['30 days','10 days']`; `drop: 5`.
  - `plugin.setup(plugin.defaultConfig).evidenceSources.map(s => s.name)` → `['chat_message']`; `plugin.setup({timeAxes: []}).evidenceSources` → `[]`.
- [ ] **Step 2: Run** `npx vitest run packages/core-plugin/test/sources.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `sources.ts` and config changes.
- [ ] **Step 4: Run** `npm test` (server `app.test.ts` starts the core plugin with the new default) and `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: declarative evidence sources in core plugin`.

### Task 5: Evidence ingest and reads through `apply` / `query`

**Files:**
- Create: `packages/server/src/services/evidence.ts`
- Modify: `packages/server/src/api/apply.ts` (handler `add_evidence`, `EVIDENCE_OPS = new Set(['add_evidence'])`, remove `add_evidence` from `DEFERRED`), `packages/server/src/api/query.ts` (`list_evidence_sources`, `get_evidence`), `packages/server/test/query.test.ts` (drop both from the deferred list), `packages/server/test/apply.test.ts` (the `add_evidence` deferred assertion becomes a missing-`source` `invalid_param` case)
- Test: `packages/server/test/evidence.test.ts`

**Interfaces:**
- Consumes: Task 3 (`getSource`, `fakeSource`, `seedAxes` with sources), `compileCached`, `ajv`.
- Produces:
  - `addEvidence(db: Queryable, registry: PluginRegistry, a: { source: string; payload: unknown }): Promise<{ id: bigint }>` (R16)
  - `interface EvidenceRow { id: bigint; source: string; payload: unknown; createdAt: Date; purgedAt: Date | null; pinned: boolean }`
  - `getEvidence(db: Queryable, id: bigint): Promise<EvidenceRow>` (`not_found`)
  - `interface EvidenceSourceRow { name: string; description: string; payloadSchema: unknown }`; `listEvidenceSources(db: Queryable): Promise<EvidenceSourceRow[]>`
  - apply op `add_evidence{source, payload}` → `{id}`; query ops per R21 (`id` via `int()`, must be ≥ 1 else `invalid_param`).

- [ ] **Step 1: Write failing tests** (sources: `fakeSource('chat', {ingest: (p) => ({payload: {text: (p as {text: string}).text}, retentionState: {stage: 0}})})`, `fakeSource('raw')`, unavailable `'down'`):
  - `addEvidence('chat', {text:'hi', secret:1})` → row has `payload {text:'hi'}`, `retention_state {stage:0}`, correct `source_id`; `'raw'` → `retention_state` SQL `NULL`.
  - `{}` for `chat` → `invalid_payload` with `details.source 'chat'`; `'nope'` → `unknown_source`; `'down'` → `source_unavailable`; ingest throwing `new Error('x')` → `invalid_payload`; ingest returning `{}` → `invalid_plugin`.
  - `apply`: `[add_evidence chat as e1, add_property bob nickname 'Bobby' evidence '$e1', add_relation … evidence '$e1']` → `results[0]` is `{id: <number>, as: 'e1'}` and both fact rows carry that `evidence_id`; `add_property` with `entity: '$e1'` → `unknown_ref`; `add_evidence` without `payload` → `invalid_param`; the evidence id from one batch used numerically in a later batch works.
  - `query`: `list_evidence_sources` → rows for `chat`, `raw`, `down` with `payload_schema` deep-equal to the stored schema; `get_evidence` → `{id, source:'chat', payload:{text:'hi'}, created_at: <ISO>, purged_at: null, pinned: false}`; `id: 999` → `not_found`; `id: 0` → `invalid_param`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/evidence.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `evidence.ts` and the handlers.
- [ ] **Step 4: Run** the test file, `apply.test.ts`, `query.test.ts`, `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: add_evidence, evidence references and evidence reads`.

### Task 6: Evidence maintenance (retention, purge, pin) and `RemoraApp` methods

**Files:**
- Create: `packages/server/src/services/evidence-maintenance.ts`
- Modify: `packages/server/src/app.ts` (methods), `packages/server/src/api/apply.ts` only if `rollback` must be shared (import it, do not copy)
- Test: `packages/server/test/evidence-maintenance.test.ts`, `packages/server/test/evidence-e2e.test.ts`

**Interfaces:**
- Consumes: Task 3 (`getSource`, `listSources`), Task 5 (`getEvidence`, `addEvidence`), Task 4 (core `buildSource` via the real core plugin), `RetentionRow`/`RetentionAction`.
- Produces:
  - `RETENTION_BATCH = 500`, `PURGE_BATCH = 1000`
  - `interface RetentionReport { processed: number; kept: number; replaced: number; purged: number; skipped: string[] }`
  - `applyRetention(pool: pg.Pool, registry: PluginRegistry, a?: { source?: string; batchSize?: number; now?: Date }): Promise<RetentionReport>` (R18)
  - `type PurgeArgs = { ids: bigint[] } | { source: string; olderThan: Date }`; `purgeEvidence(pool: pg.Pool, a: PurgeArgs): Promise<{ purged: number; skippedPinned: number }>` (R19)
  - `pinEvidence(db: Queryable, id: bigint): Promise<void>`, `unpinEvidence(db: Queryable, id: bigint): Promise<void>` (R20)
  - `RemoraApp.applyRetention(a?)`, `purgeEvidence(a)`, `pinEvidence(id)`, `unpinEvidence(id)` bound to the app's pool/registry (R26).

- [ ] **Step 1: Write failing tests** in `evidence-maintenance.test.ts` (seed like Task 5: sources `chat`, `raw`, unavailable `down`; `chat`'s `planRetention` is a `vi.fn` that purges rows with `payload.text === 'old'`, replaces `'trim'` with `{text:'t'}` / `{stage:1}`, and omits the rest; rows created with `addEvidence`):
  - one run over `old`, `trim`, `keep`, and a pinned `old` → report `{processed:3, kept:1, replaced:1, purged:1, skipped:[]}`; the spy never saw the pinned id (Review Focus 4); purged row has `payload` NULL, `retention_state` NULL, `purged_at` set; second run → `processed 2` (purged rows not passed), no further changes.
  - batching: 1 200 rows inserted by SQL → spy call sizes `[500, 500, 200]`; `batchSize: 0` and `10001` → `invalid_param`.
  - misbehaving plugin (Review Focus 4), each its own test: action for an id outside the batch, duplicate id, `{action:'zap'}`, `replace` without `payload`, plain `throw` → `invalid_plugin` and no row of that batch changed; with `batchSize: 2` and the bad action only in the second batch, the first batch's changes persist.
  - sources: no `source` → processes `chat` and `raw`, `skipped: ['down']`; `source:'nope'` → `unknown_source`; `source:'down'` → `source_unavailable`.
  - purge: `{ids:[a, pinned]}` → `{purged:1, skippedPinned:1}`; repeat → `{purged:0, skippedPinned:1}`; `{ids:[a, 999n]}` → `not_found` and `a` unchanged; `{ids: []}` → `invalid_param`; `{source:'chat', olderThan}` purges only rows whose `created_at` (set by SQL) is older; `{source:'nope', ...}` → `unknown_source`.
  - pin/unpin idempotent; unknown id → `not_found`.
  - purged evidence (Review Focus 5): a property written with the evidence keeps `evidence_id` in `property_history`; `getEvidence` returns `payload null`, `purgedAt` set.
- [ ] **Step 2: Write failing e2e** in `evidence-e2e.test.ts` with the real core plugin (fake importer as in `facts-e2e.test.ts`): start once, close, `UPDATE plugin SET config = jsonb_set(config, '{evidenceSources}', $1::jsonb)` with a `tg` source (`keep: ['text','attachments']`, stages `30 days → ['attachments']`, `365 days → '*'`), start again; `app.apply` `add_evidence tg {text:'hi', attachments:['a.png'], noise:1}` → `get_evidence` payload `{text:'hi', attachments:['a.png']}`; `app.applyRetention({now: +40 days})` → payload `{text:'hi'}`; `app.applyRetention({now: +400 days})` → `payload null`, `purged_at` set; `app.pinEvidence` on a second row makes it survive `+400 days`.
- [ ] **Step 3: Run** both files; expect FAIL.
- [ ] **Step 4: Implement** `evidence-maintenance.ts` and the app methods.
- [ ] **Step 5: Run** both files + `npm run typecheck`; expect PASS.
- [ ] **Step 6: Commit** `feat: evidence retention, purge and pinning`.

### Task 7: Event writes (`add_event`, `update_event`, `retract_event`)

**Files:**
- Modify: `packages/server/src/services/time.ts` (event time parse/format)
- Create: `packages/server/src/services/events.ts`
- Modify: `packages/server/src/api/apply.ts` (three handlers; delete the now-empty `DEFERRED`)
- Test: `packages/server/test/time.test.ts` (extend), `packages/server/test/events.test.ts`

**Interfaces:**
- Consumes: `encodeValue`, `AxisRef`, `requireEntity`, `normalizeName`, `entityArg`/`evidenceArg` (apply.ts, for each `entities[i].entity` and `evidence`), Task 5 (`add_evidence` for `$e1`).
- Produces:
  - `interface EventSpan { axis: AxisRef; lo: bigint | null; hi: bigint | null; instant: boolean }`; `parseEventTimes(registry: PluginRegistry, raw: unknown): EventSpan[]` (R22; `undefined` → `invalid_param`)
  - `interface EventTimeOut { axis: string; at?: unknown; from?: unknown; to?: unknown }`; `formatEventTime(registry: PluginRegistry, axisId: number, lo: string | null, hi: string | null, instant: boolean): EventTimeOut`
  - `normalizeKeywords(raw: string[]): string[]` (R23)
  - `interface EventEntityIn { entity: string; role?: string }`
  - `addEvent(db, a: { summary: string; details?: string; keywords?: string[]; times: EventSpan[]; entities?: EventEntityIn[]; evidenceId?: bigint }): Promise<{ id: bigint }>`
  - `interface EventUpdate { id: bigint; summary?: string; details?: string | null; keywords?: { set: string[] } | { add?: string[]; remove?: string[] }; times?: EventSpan[]; entities?: { add?: EventEntityIn[]; remove?: EventEntityIn[] }; evidenceId?: bigint }`; `updateEvent(db, u: EventUpdate): Promise<{ id: bigint }>` (R24; lock with `SELECT ... FOR UPDATE`)
  - `retractEvent(db, a: { id: bigint; evidenceId?: bigint }): Promise<{ id: bigint }>`
  - apply ops `add_event{summary, details?, keywords?, time, entities?, evidence?}`, `update_event{id, summary?, details?, keywords?, time?, entities?, evidence?}`, `retract_event{id, evidence?}` → `{id}`. `entities` items may use `$name` for `entity` (R4).

- [ ] **Step 1: Write failing tests.** `time.test.ts`: `parseEventTimes` for `{axis:'game_day', at:300}` → `lo 300n, hi 301n, instant true`; `{axis:'game_day', from:299, to:301}` → `instant false`; `{axis:'game_day'}` → both bounds `null`; two axes in an array; `[]`, `undefined`, duplicate axis, `{axis, at, from}` → `invalid_param`; `from:5, to:5` → `invalid_time`; `big` axis `at {v:'9223372036854775807'}` → `invalid_time`; `formatEventTime` for instant → `{axis:'game_day', at:300}`, for open span → `{axis:'game_day', from:299}`. `events.test.ts` (rows checked by SQL):
  - `addEvent` stores `event`, one `event_time` per axis, `event_entity` with roles `'Eye Witness'` → `eye_witness` and default `participant`; keywords `['Salto',' salto ','Park']` → `{salto,park}`; `summary: '  '` → `invalid_param`; keyword `''` → `invalid_param`; unknown entity → `unknown_entity`.
  - `updateEvent`: summary change sets `updated_at`; `{keywords:{add:['X'], remove:['salto']}}` → `{park,x}`; `{set: []}` → `{}`; `{set:[...], add:[...]}` → `invalid_param`; `times` on `game_day` replaces that row and a new `real` row is added while others stay; `entities.add` of an existing pair is a no-op; `entities.remove [{entity:'bob'}]` removes all bob roles; removing an unattached entity → `not_found`; `details: null` clears; only `id` → `invalid_param`; missing id → `not_found`; retracted event → `not_found`.
  - `retractEvent` sets `retracted_at` and `retracted_evidence_id`; twice → `not_found`.
  - `apply` (seed `seedAxes(pool, s, [fakeSource('chat')])`): batch `[add_evidence chat {text:'x'} as e1, create_entity carl as c, add_event {summary, time:{axis:'game_day', at:300}, entities:[{entity:'$c', role:'actor'},{entity:'bob'}], keywords:['salto'], evidence:'$e1'}, update_event, retract_event]` → `ok`, `add_event` result `{id: <number>}`, stored `evidence_id` = the evidence id.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/time.test.ts packages/server/test/events.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the time helpers, `events.ts` and the handlers.
- [ ] **Step 4: Run** both files, `apply.test.ts`, `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: event write operations`.

### Task 8: Event reads and `search_events` performance sanity

**Files:**
- Create: `packages/server/src/services/events-read.ts`
- Modify: `packages/server/src/api/query.ts` (four ops; event row mapper), `packages/server/test/query.test.ts` (deferred list now only `'frobnicate'`)
- Test: `packages/server/test/events-read.test.ts`

**Interfaces:**
- Consumes: Task 7 (`addEvent`, `formatEventTime`, `normalizeKeywords`), `wordPatterns`, `clampLimit`, `requireEntity`, `When`.
- Produces:
  - `interface EventRow { id: bigint; summary: string; details: string | null; keywords: string[]; time: EventTimeOut[]; entities: { entity: string; role: string }[]; evidenceId: bigint | null; recordedAt: Date; updatedAt: Date | null; retractedAt: Date | null }`
  - `getEvent(db, registry, id: bigint): Promise<EventRow>` (`not_found`)
  - `interface SearchEventsArgs { text?: string; keywords?: string[]; match?: 'any' | 'all'; entities?: string[]; when?: When; limit?: number }`; `searchEvents(db, registry, a): Promise<{ rows: EventRow[]; total: number; truncated: boolean }>` (R25)
  - `entityEvents(db, registry, a: { entity: string; when?: When; limit?: number })` (= `searchEvents` with `entities: [entity]`)
  - `listEventRoles(db): Promise<string[]>`
  - query ops `get_event{id}` → event row; `search_events{...}` and `entity_events{entity, when?, limit?}` → `{rows, total, truncated}`; `list_event_roles` → `{roles}`. Page rows are loaded first, then `event_time` and `event_entity` for the page ids (two queries).

- [ ] **Step 1: Write failing tests** (events via `addEvent`): `getEvent` full shape, instant time `{axis:'game_day', at:300}`, retracted event still returned with `retractedAt`; `999n` → `not_found`. `searchEvents`: `keywords:['SALTO']` finds `salto`; `any` vs `all` on `['salto','park']`; `text:'сальт'` matches in `summary`, another word matches only in `details`; `text:'вчера сальт'` requires both words; `text:'100%'` treats `%` literally; `entities:['bob','carl']` returns only events with both; `when {game_day, at:300}` matches `[299,301)` and instant 300 but not an event with time only on `real`; `when during [290,310)`; ordering with `when` newest (largest lower bound) first, without `when` by id desc; retracted excluded; `limit:1` → `total`/`truncated`; `keywords: []` → `invalid_param`; `match:'some'` → `invalid_param`; unknown entity → `unknown_entity`. `entityEvents('bob')`; `listEventRoles` → sorted distinct roles of non-retracted events. Through `query()`: the snake_case row shape of R25.
  - Performance sanity (spec 15 q.3; test timeout 60 s): insert 3 000 events by SQL (`generate_series`; keywords from a pool of 20 words, summary `'event ' || i || ' ' || <word>`, `event_time` on `game_day` `[i, i+1)` instant, `event_entity` to one of 50 entities), `ANALYZE`; run `searchEvents` with (a) keywords any, (b) keywords all of two, (c) text, (d) entities + when during, (e) all combined; each call finishes in < 1 000 ms wall time and its `total` equals an independent `count(*)` written directly in the test. Index use is not asserted.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/events-read.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `events-read.ts` and the query handlers.
- [ ] **Step 4: Run** the test file, `query.test.ts`, `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: event reads and search`.

### Task 9: End-to-end scenario and exports

**Files:**
- Modify: `packages/server/src/index.ts` (export `neighbors`, evidence, maintenance and event services and their public types, `SourceInfo`)
- Test: `packages/server/test/graph-events-e2e.test.ts`

**Interfaces:**
- Consumes: everything above through `startRemora` with the default core config (`chat_message`).

- [ ] **Step 1: Write the failing e2e** (fake importer as in `facts-e2e.test.ts`): one `app.apply` batch reproducing spec 10.1 — `add_evidence chat_message as e1 {text:'Боб теперь Senior в Google', sender:'me', raw:'x'}`, `create_entity bob/carl/google`, types `job_title` (text, single), `height` (number, single), `works_at` (directed), `friend_of` (undirected), `replace_property bob job_title Senior {game_day at 292} evidence $e1`, `add_relation works_at bob→google {game_day from 292} evidence $e1`, `add_relation friend_of bob–carl`, `add_property carl height 186`, `add_event {summary:'Видел Боба, он сделал сальто', keywords:['Сальто'], time:{axis:'game_day', at:300}, entities:[{entity:'bob', role:'actor'}], evidence:'$e1'}` → `ok`. Then one `app.query`: `neighbors {entity:'bob', depth:1, include:['height'], order_by:{property:'height', dir:'desc'}, limit:1}` → `[{entity:'carl', …, properties:{height:[186]}}]`; `search_events {keywords:['сальто'], when:{axis:'game_day', at:300}}` → one row with `evidence_id` = e1; `get_evidence` → payload without `raw`. Then `app.purgeEvidence({ids:[e1]})`; `relation_history` and `get_event` still return `evidence_id` = e1 and `get_evidence` gives `payload: null` (Review Focus 5). Also `import { neighbors, addEvidence, applyRetention, searchEvents } from '../src/index.js'` resolves.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/graph-events-e2e.test.ts`; expect FAIL (missing exports).
- [ ] **Step 3: Implement** the exports (fix any defect the scenario reveals in the owning module).
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`; expect all green.
- [ ] **Step 5: Commit** `test: graph, events and evidence end to end`.

---

## Parked for plan 4

HTTP/MCP transport for `apply`/`query` and the R26 maintenance methods (status codes for thrown `RemoraError`); JSON Schema contract including the new ops; scheduled `apply_retention` (spec 15 q.4, auto-run); admin warning when a plugin config change touches sources with data; re-running `planRetention` after config change (v2).
