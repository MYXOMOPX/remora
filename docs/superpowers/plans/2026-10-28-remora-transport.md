# Remora Transport, Contract and Packaging Implementation Plan (plan 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make remora a runnable, usable service: a published JSON Schema contract with request validation, an HTTP API behind a secret URL, an MCP endpoint, an operator (admin) API, hardened startup with a plugin directory, a fix for the `neighbors` hub regression, a real build, a Docker image with compose, and v1.0.0 docs.

**Architecture:** `RemoraApp` (in-process, plans 1–3) stays the core. New layers on top of it: `src/contract/` (hand-authored JSON Schemas + ajv validator, used by both transports and served at `/schema`), `src/transport/dispatch.ts` (validate → `app.apply`/`app.query`), `src/http/` (a `node:http` server: secret routing, body limits, status mapping, JSON logs, graceful shutdown, admin routes), `src/mcp/` (official MCP SDK, low-level `Server`, stateless Streamable HTTP mounted on the same HTTP server), `src/main.ts` + `src/config.ts` (env → config → start). Packages build with `tsc` to `dist/` and resolve through a `source` export condition during development and tests.

**Tech Stack:** Node.js 24, TypeScript 7 (ESM, NodeNext), PostgreSQL 18 via `pg`, `ajv` + `ajv-formats`, `@modelcontextprotocol/sdk` **1.32.1** (exact), `node:http`, `node:crypto`, vitest + testcontainers, Docker (`node:24-bookworm-slim`, `postgres:18`).

**Spec:** `docs/superpowers/specs/2026-10-22-historicity-design.md` — sections 2 (architecture, transport, secret URL), 10 ("Контракт", error envelope), 12 (operator evidence ops), 13 (plugin connection, startup, config change), 15 (open question 1, and the status of the others). Plans 1–3 (`2026-10-26-remora-foundation.md`, `2026-10-26-remora-facts.md`, `2026-10-27-remora-graph-events-evidence.md`) are merged on `master`; their Global Constraints and Rulings R0–R26 still hold.

**Execution:** Sonnet implementers and Opus reviewers via subagent-driven-development in the worktree `D:\AIWorkspace\remora-wt-p4` (branch `feat/transport`, `node_modules` installed). Never touch `D:\AIWorkspace\remora`. Each task: read the files it lists plus `src/app.ts`, `src/api/apply.ts`, `src/api/query.ts` before starting.

## Global Constraints

- Code, identifiers, log messages, error messages and contract descriptions: English. Tests assert on `code` (and `details`/HTTP status where stated), never on message text.
- Error codes only from `ERROR_CODES` in `@remora/sdk`. This plan adds exactly two: `internal` and `timeout` (R32, Task 2). No others.
- New runtime dependency: `@modelcontextprotocol/sdk` pinned **exactly** `1.32.1` (published 2026-10-05; verified on npm) in `@remora/server`. No web framework, no logger, no CLI library: `node:http`, `node:crypto`, `node:util` only. No new dev dependencies.
- The in-process API (`RemoraApp.apply/query`, services) keeps its current behaviour and tests; the contract validator runs only at the transport boundary (R33). Existing tests must stay green after every task.
- One client never has two queries in flight; all SQL parameterised; `jsonb` via `JSON.stringify` + `$n::jsonb` (plans 2–3).
- Secrets (`REMORA_SECRET`, `REMORA_ADMIN_SECRET`) and request bodies never appear in logs, error messages or `details`.
- Tests: DB tests use one fresh database per test (`createTestDb`), apps are closed in `finally`. HTTP tests listen on port `0` and use global `fetch`. Single file: `npx vitest run packages/server/test/<file>.test.ts`; suite `npm test`; types `npm run typecheck` (repo root).
- Commits: add files by name (never `git add -A`; the repo root has unrelated untracked files); end each message with the implementer's own line, e.g. `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Rulings (spec gaps and deviations; numbering continues plan 3's R11–R26)

- **R27 MCP tools.** "Operations become MCP tools one to one" (spec 2) is read as the two API operations: tools `apply` and `query`, whose `inputSchema` is exactly the contract request schema (`{ops: [...]}` with every op as a `oneOf` branch). Per-op tools would lose batch atomicity and `$name` references. Tool result: `structuredContent` = the `{ok, …}` envelope, `content: [{type:'text', text: JSON.stringify(envelope)}]`, `isError = !envelope.ok`. Operator ops are never MCP tools.
- **R28 MCP transport.** Streamable HTTP only, **stateless** (`sessionIdGenerator: undefined`, `enableJsonResponse: true`; a fresh low-level `Server` + `StreamableHTTPServerTransport` per POST — verified with SDK 1.32.1 over `node:http`), mounted at `POST /<secret>/mcp`; `GET`/`DELETE` there → 405. stdio is deferred (clients use the HTTP URL; `mcp-remote` bridges stdio-only clients).
- **R29 secret URL.** `REMORA_SECRET` is required (start fails with `invalid_config` if missing or malformed). Format: ≥ 43 chars of `[A-Za-z0-9_-]` (32 random bytes base64url). `generateSecret()` = `randomBytes(32).toString('base64url')`, exposed as `node packages/server/dist/main.js gen-secret`. Comparison: `timingSafeEqual(sha256(candidate), sha256(secret))`. A wrong or missing secret segment → `404` with `{ok:false, error:{op_index:-1, code:'not_found', message:'not found'}}`, identical to an unknown path. One secret per service (spec 15 "Решено").
- **R30 admin auth.** Operator ops live under a second secret: `REMORA_ADMIN_SECRET` (same format, must differ from `REMORA_SECRET`, else `invalid_config`), routes `/<admin_secret>/admin/<op>`. Unset → admin routes are disabled (404) and a `warn` log line says so at start. Same mechanism as the LLM URL, no headers/tokens.
- **R31 HTTP surface.** `node:http`, no framework. Routes: `GET /health` (no secret, R36); `POST /<secret>/apply`, `POST /<secret>/query`, `GET /<secret>/schema`, `POST /<secret>/mcp`; admin per R30/R40. POST bodies: `Content-Type` must be `application/json` (params ignored) else `415`; size limit `REMORA_MAX_BODY_BYTES` (default 1 048 576) → `413`; invalid JSON → `400`; all with the error envelope (`code: 'invalid_param'`, `op_index: -1`). Unknown path or method mismatch on a known path → `404` / `405`. Status for envelopes with `ok:false`: `400` invalid_param, invalid_time, invalid_name, invalid_payload, value_type_mismatch, unknown_ref, invalid_config, invalid_plugin; `404` not_found, unknown_entity, unknown_type, unknown_axis, unknown_source; `409` single_valued_conflict, timeless_conflict, name_taken, concurrent_update; `422` too_many_paths; `503` axis_unavailable, source_unavailable; `504` timeout; `500` internal. `ok:true` → `200`. Every response has `x-request-id` (random UUID). Unexpected throws → `500` `{code:'internal', message:'internal error', details:{request_id}}`; the stack goes to the log only. Server timeouts: `requestTimeout = REMORA_REQUEST_TIMEOUT_MS` (default 30 000), `headersTimeout = 10 000`, `keepAliveTimeout = 5 000`.
- **R32 new codes.** `internal` (transport only: unexpected failure) and `timeout` (PostgreSQL `57014` query_canceled from `statement_timeout`; the batch is rolled back; narrow the request). Both added to `ERROR_CODES` and to the spec 10.1 code list. **Deviation:** spec 10.1's list is extended (as plan 1 did).
- **R33 contract.** Hand-authored JSON Schemas as TS constants in `src/contract/` (no generator), inlined (no `$ref`), JSON-Schema draft-07 keywords only (also valid 2020-12). Validation at the transport boundary only (`validateApplyRequest` / `validateQueryRequest`), run per op: an unknown `op` → `invalid_param` `details:{op}`; otherwise the op's own schema. **Equivalence rule:** a schema may reject an input only where the current handler also rejects it with `invalid_param`; inputs the handlers map to other codes (`invalid_name` for `$`-prefixed or empty-after-normalisation names, `unknown_ref` for non-positive or fractional numeric `evidence`, `invalid_time` for time values, `unknown_*` for names) stay permissive in the schema (e.g. `name: {type:'string'}` without `minLength`; `evidence: {type:['number','string']}`; time values `{}`; `limit: {type:'integer', minimum:1}` without maximum — values above 200 are clamped). **Tightening (deviation at the transport only):** op objects and their nested objects have `additionalProperties: false` (LLM typos such as `entity_key` are reported instead of ignored); `as` is allowed only on apply ops. Error: `{op_index: i, code:'invalid_param', message: '<field> <ajv message>', details: {field: '<dotted path inside the op, e.g. time.axis or ops>', reason: '<ajv message>'}}`; when several ajv errors exist, report the one with the deepest `instancePath`, skipping `oneOf`/`anyOf` keywords unless nothing else is left. `ops` must be a non-empty array of at most `MAX_OPS = 1000` items (also enforced in `apply()`/`query()`: `invalid_param`, `op_index -1`, `details: {limit: 1000}`; carry-over: there was no cap).
- **R34 null time values.** An explicit `null` for `from`, `to`, `at` or a `during` item is `invalid_time` (`details: {axis, reason: 'null is not a time value; omit the bound instead'}`), checked in `time.ts` before the axis `valueSchema`, so it does not depend on the plugin. An omitted bound means unbounded. `details: null` on `update_event` (clears details) is unaffected.
- **R35 contract text.** Every op schema has an English `description` written for an LLM (what it does, when to use it, its time semantics, notable errors) and one `examples` entry that validates against the schema. The schemas are the MCP documentation (spec 10 "Контракт").
- **R36 health.** `GET /health` (no secret) runs `SELECT 1` on the pool: `200 {status:'ok'}`, or `200 {status:'degraded'}` when any plugin status is `ok:false`; `503 {status:'unavailable'}` when the DB query fails; `503 {status:'shutting_down'}` during shutdown. No plugin names (the admin API has them).
- **R37 plugin directory (spec 13, open question 1).** `PLUGINS_DIR` (default `<cwd>/plugins`; `/plugins` in the container, a mounted volume). Operators install with `npm install --prefix "$PLUGINS_DIR" <pkg>`. `plugin.package` stores the spec exactly as given to `add_plugin`. Resolution (`pluginImporter(pluginsDir)`): `@remora/core-plugin` → the statically imported core plugin; a spec starting with `.`, `/` or a drive letter is a path resolved against `PLUGINS_DIR` — a file is imported directly, a directory uses its `package.json` entry (`exports` string, `exports['.']` string, `exports['.'].import`, `exports['.'].default`, `main`, else `index.js`); any other spec is a package name looked up manually as `<PLUGINS_DIR>/node_modules/<name>` (scoped `@scope/name` = two segments; `..`, empty segments and backslashes are rejected) and its `package.json` entry is applied by the same rules (a top-level conditional `exports` object without a `.` key counts as the dot entry); `import.meta.resolve`'s parent argument is not used (plain Node ignores it without a flag). A spec containing a backslash or a drive letter is a path. Resolution/import failure → `invalid_plugin` (add_plugin) or degraded plugin (start). Third-party plugins export a plain object `{name, configSchema, defaultConfig, setup}`; `@remora/sdk` is not published in v1 (README says so).
- **R38 plugin load checks.** In `loadPlugins`: the package's `def.name` must equal the stored `plugin.name` (else `invalid_plugin`); duplicate axis/source names inside one setup result → `invalid_plugin`; an axis/source name owned by another plugin → `name_taken`. All are checked **before** any upsert of that plugin and inside its `try`: a non-core plugin degrades (status `ok:false`, loud `error` log, its axes/sources unavailable); `remora-core` fails the start. **Precision of spec 13** ("ошибка при старте"): the error is per plugin, not for the whole service.
- **R39 startup lock.** `startRemora` takes `pg_advisory_lock(hashtextextended('remora:startup', 0))` on one dedicated pool client and runs migrations, core registration and `loadPlugins` on that client, then unlocks and releases it (also on failure). Two replicas starting together serialise.
- **R40 operator API (spec 12, 13).** `POST /<admin>/admin/<op>` with a JSON object body (`GET` also allowed for `list_plugins`). Response `{ok:true, result}` or `{ok:false, error:{code, message, details?}}` (no `op_index`), statuses per R31. Ops: `list_plugins` → `{rows:[{id, name, package, config, status:'ok'|'degraded'|'pending_restart', error?, axes:[names], sources:[names]}]}` (`pending_restart` = row added after this process loaded plugins); `add_plugin {package}` → `{id, name, restart_required:true}`; `set_plugin_config {name, config, confirm?}` — loads the package, validates `config` with its `configSchema` (`invalid_config`) and its `setup(config)` result (R38 checks; errors as thrown); if any axis or source owned by the plugin has data (property_version/relation/event_time rows on the axis; evidence_log rows of the source) and `confirm !== true` → `invalid_param` with `details: {reason:'confirm_required', affected:{axes:[...], sources:[...]}}` (conservative: any config change may change encoding); otherwise stores it → `{name, restart_required:true}`; `remove_plugin {name}` — `remora-core` → `invalid_plugin`; unknown → `not_found`; any of its axes/sources has data → `invalid_param` `details:{reason:'has_data', axes, sources}`; else one transaction deletes its `time_axis`, `evidence_source` and `plugin` rows → `{name, restart_required:true}`; `apply_retention {source?, batch_size?}` → R18 report (snake_case); `purge_evidence {ids} | {source, older_than: ISO-8601}` → `{purged, skipped_pinned}` (unparsable `older_than` → `invalid_param`); `pin_evidence {id}`, `unpin_evidence {id}` → `{id}`. Plugin changes take effect after restart (spec 13). Admin bodies are validated by hand with `api/args.ts` (they are not part of the LLM contract).
- **R41 statement timeout.** The pool sets `statement_timeout = REMORA_STATEMENT_TIMEOUT_MS` (default 30 000; `0` disables). `mapPgError` maps `57014` → `timeout`.
- **R42 logging.** JSON lines on stdout: `{ts, level, msg, ...meta}`, levels `debug|info|warn|error`, `LOG_LEVEL` default `info`. One `info` access line per request: `{msg:'request', request_id, method, route, status, ms, ops?, code?}` where `route` replaces secrets with `:secret` / `:admin_secret`. The logger satisfies the registry `Logger` interface.
- **R43 graceful shutdown.** `SIGTERM`/`SIGINT` → stop accepting, new requests on open connections get `503` (`shutting_down`), wait for in-flight requests up to `REMORA_SHUTDOWN_TIMEOUT_MS` (default 10 000), then close remaining connections, `app.close()`, exit 0. `app.close()` is idempotent (memoised promise).
- **R44 build.** Each package's `exports['.']` becomes `{"source": "./src/index.ts", "default": "./dist/index.js"}`; `tsconfig.base.json` gets `customConditions: ["source"]`; vitest resolves with `resolve.conditions` and `ssr.resolve.conditions` = `['source']` and `extends: true` on both projects (verified: tests run from source with no `dist`). `tsconfig.build.json` per package (`noEmit:false, outDir:dist, rootDir:src, declaration:true, customConditions:[]`, include `src`), built in order sdk → core-plugin → server, so `node` uses `dist`. Versions become `1.0.0`.
- **R45 neighbors hub regression (finding).** Reproduced on this branch: start `s` → `hub` → 50 000 leaves, no `ANALYZE`, `neighbors {entity:'s', depth:2}` took 92 s (depth 3: 115 s). The level CTE is fine (≤ 0.4 s); the `via` query is the culprit: without statistics the planner nests the 50 002-row `unnest(levels)` function scan inside each of the hub's 50 001 edges (`OR` join condition, ≈2.5·10⁹ comparisons). With `ANALYZE` it is 0.36 s, so it is a plan-stability bug, not an index gap. Fix (prototyped: 92 s → 0.26 s; depth 3: 0.40 s; depth 6: 0.82 s on 100 001 entities): page entities' candidate edges are found from the page side through the existing `relation_src_idx`/`relation_dst_idx` in two `UNION ALL` branches (no `OR`), and joined to a `MATERIALIZED` CTE of the level set by `(entity_id, depth)` — a hash join, independent of statistics.
- **R46 still deferred (spec 15).** Scheduled `apply_retention`, stdio MCP, per-op MCP tools, publishing `@remora/sdk`, hot plugin reload, plugin config migration (re-encoding), installing packages from the admin API — all v2 (spec 15 item 5 lists most of them).

## Review Focus

1. A wrong secret that is a prefix/suffix/case variant of the real one (`/<secret>x/apply`, `/<SECRET>/apply`, `//apply`) gets the same 404 as an unknown path, and neither secret ever appears in a log line. (Task 6)
2. Hostile bodies — invalid JSON, a JSON array or string, a 2 MiB body, a chunked body without `Content-Length` that exceeds the limit, 1 001 ops — produce 400/413 envelopes, never 500, and the server keeps serving the next request. (Task 6, Task 2)
3. LLM-style loose input through MCP — `"depth": "2"`, extra keys, `time: {axis, from: null}`, a missing `op` — returns an envelope with `op_index` and `details.field` (or `invalid_time` for null), never a 500 or an SDK protocol error. (Task 7)
4. A broken third-party plugin — missing package, module that throws on import, name mismatch with its row, an axis name owned by another plugin — leaves the service up (`/health` → `degraded`), `list_plugins` shows the error, and core ops keep working. (Task 4, Task 5, Task 8)
5. Shutdown with a request in flight: the in-flight request completes with its real status, a new request on a kept-alive connection gets 503, and the pool closes once (a second `close()` resolves). (Task 6)

---

### Task 1: `neighbors` hub regression

**Files:**
- Modify: `packages/server/src/services/facts-read.ts` (`whenClause` alias parameter), `packages/server/src/services/neighbors.ts` (step 3, the `via` query)
- Test: `packages/server/test/neighbors-hub.test.ts`

**Interfaces:**
- Produces: `whenClause(when: When | undefined, firstParam: number, alias?: string): { sql: string; params: unknown[] }` — with `alias` the columns are emitted as `${alias}.time_axis` / `${alias}.time_span`; without it, unchanged output (existing callers untouched).
- `neighbors()` signature and results unchanged (R12 semantics: same `via`, `via_count`).

Rewrite of the `via` query (R45), same parameter list as today:

```sql
WITH t(entity_id, depth) AS (SELECT * FROM unnest($1::bigint[], $2::int[])),
     pl(entity_id, depth) AS MATERIALIZED (SELECT * FROM unnest($3::bigint[], $4::int[])),
     e AS (
       SELECT t.entity_id AS tgt, rel.id, rel.relation_id, rel.src AS pred, t.depth
         FROM t JOIN relation rel ON rel.dst = t.entity_id AND rel.relation_type_id = ANY($5::smallint[])
        WHERE rel.retracted_at IS NULL AND <whenClause(when, 7, 'rel')>
       UNION ALL
       SELECT t.entity_id, rel.id, rel.relation_id, rel.dst, t.depth
         FROM t JOIN relation rel ON rel.src = t.entity_id AND rel.relation_type_id = ANY($6::smallint[])
        WHERE rel.retracted_at IS NULL AND <same clause>
     ),
     v AS (
       SELECT e.tgt AS entity_id,
              (array_agg(e.id   ORDER BY e.relation_id, e.id))[1] AS rel_pk,
              (array_agg(e.pred ORDER BY e.relation_id, e.id))[1] AS pred,
              count(DISTINCT e.relation_id) AS cnt
         FROM e JOIN pl ON pl.entity_id = e.pred AND pl.depth = e.depth - 1
        GROUP BY e.tgt)
SELECT v.entity_id, rt.name AS type, pe.key AS pred_key, r.relation_id, r.time_axis,
       lower(r.time_span)::text AS lo, upper(r.time_span)::text AS hi, v.cnt
  FROM v JOIN relation r ON r.id = v.rel_pk
  JOIN relation_type rt ON rt.id = r.relation_type_id
  JOIN entity pe ON pe.entity_id = v.pred
```

(Branch 1 reaches `t` along `src→dst`, so it uses the out-type set `$5`; branch 2 reaches `t` along `dst→src` with `$6` — the same pairing as today's `OR`.)

- [ ] **Step 1: Write the failing test** `neighbors-hub.test.ts` (fresh DB, `runMigrations`, `seedBasics`, `seedAxes`; type `knows` directed; data by SQL with `generate_series`, **no `ANALYZE`**): entities `s`, `hub`, `l1..l50000`, `c1..c50000`; relations `s→hub`, `hub→l_i`, `l_i→c_i`. Per call measure wall time with `performance.now()`:
  - `neighbors {entity:'s', depth:2}` → `total 50001`, `< 10 000 ms`; the page (default order: depth, key) is `hub` (`depth 1`, `via.from 's'`) followed by 49 `l*` rows, each with `depth 2`, `via.from === 'hub'`, `via.relation === 'knows'`, `viaCount 1`.
  - depths 3, 4, 6 (default direction) → `total 100001`, each `< 10 000 ms`; `direction:'out'`, depth 6 → `total 100001`, `< 10 000 ms`.
  - `depth:2, order_by:{property:'height', dir:'desc'}` and `include:['height']` → `< 10 000 ms`.
  - test timeout 300 s.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/neighbors-hub.test.ts`; expect FAIL (the depth-2 call takes ~90 s and breaks the bound).
- [ ] **Step 3: Implement** the alias parameter and the rewritten query.
- [ ] **Step 4: Run** the new file, `packages/server/test/neighbors.test.ts`, `packages/server/test/facts-read.test.ts`, `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `src/services/facts-read.ts`, `src/services/neighbors.ts`, `test/neighbors-hub.test.ts`: `fix: neighbors via step independent of planner statistics on hubs`.

### Task 2: Request contract — error codes, op schemas, validator, null time rule, op cap

**Files:**
- Modify: `packages/sdk/src/errors.ts` (runtime list), `packages/sdk/test/sdk.test.ts`, `packages/server/src/services/time.ts` (R34), `packages/server/src/api/apply.ts` and `packages/server/src/api/query.ts` (`MAX_OPS`), `docs/superpowers/specs/2026-10-22-historicity-design.md` (10.1 code list: `internal`, `timeout`)
- Create: `packages/server/src/contract/common.ts`, `packages/server/src/contract/apply-ops.ts`, `packages/server/src/contract/query-ops.ts`, `packages/server/src/contract/validate.ts`, `packages/server/src/api/limits.ts`
- Test: `packages/server/test/contract-request.test.ts`, `packages/server/test/time.test.ts` (extend), `packages/server/test/apply.test.ts` and `packages/server/test/query.test.ts` (extend)

**Interfaces:**
- Produces (`@remora/sdk`): `export const ERROR_CODES = [ ...the 20 existing codes in their current order..., 'internal', 'timeout' ] as const; export type ErrorCode = (typeof ERROR_CODES)[number];`
- `api/limits.ts`: `export const MAX_OPS = 1000;`
- `contract/common.ts`: reusable schema fragments as `const` objects: `entityRef` (string; key or `$name`), `evidenceRef` (`type: ['number','string']`), `spanTime` (object or non-empty array of `{axis, from?, to?}`), `momentTime` (`{axis, at}`), `eventTime` (`{axis, at}` | `{axis, from?, to?}`, object or non-empty array), `when` (`oneOf` `{axis, at}` / `{axis, during: [a, b]}`), `relationSelector` pieces. Time values are `{}` (R33/R34).
- `contract/apply-ops.ts`: `export const APPLY_OPS: Record<ApplyOpName, JsonSchema>` for all 14 apply ops (`add_evidence, add_event, update_event, retract_event, create_entity, add_property, replace_property, end_property, retract_property, add_relation, end_relation, retract_relation, create_relation_type, create_property_type`, and `as` on each) with fields exactly as the handlers in `api/apply.ts` read them; `end_relation`/`retract_relation` accept `relation_id` **or** all of `type, from, to` (`oneOf`).
- `contract/query-ops.ts`: `export const QUERY_OPS: Record<QueryOpName, JsonSchema>` for all 17 query ops in `api/query.ts` (`get_entity, find_entities, property_at, property_history, relation_history, neighbors, list_relation_types, find_relation_types, list_property_types, find_property_types, list_evidence_sources, get_evidence, get_event, search_events, entity_events, list_event_roles, list_time_axes`) — `neighbors.depth` integer 1–6, `direction`/`match`/`order_by.dir` enums, `relation_types`/`keywords`/`entities` `minItems: 1` where the handler rejects empty arrays with `invalid_param`.
- `contract/validate.ts`:
  - `export const applyRequestSchema: JsonSchema; export const queryRequestSchema: JsonSchema` — `{type:'object', additionalProperties:false, required:['ops'], properties:{ops:{type:'array', minItems:1, maxItems: MAX_OPS, items:{oneOf:[...each op schema]}}}, description}` (R27 tool schemas).
  - `export function validateApplyRequest(body: unknown): ApiError | null`, `export function validateQueryRequest(body: unknown): ApiError | null` (R33; a dedicated `new Ajv({ strict: true, allowUnionTypes: true, allErrors: true })` compiling each op schema once).

- [ ] **Step 1: Write failing tests.**
  - `sdk.test.ts`: `ERROR_CODES` contains `'internal'` and `'timeout'`, has 22 unique entries.
  - `time.test.ts` (R34): `parseSpans({axis:'game_day', from:null})`, `{…, to:null}`, `parseMoment({axis:'game_day', at:null})`, `parseWhen({axis:'game_day', during:[null, 5]})`, `parseEventTimes({axis:'game_day', at:null})` → `invalid_time`; with an axis whose `valueSchema` is `{}` (accepts null) still `invalid_time`.
  - `apply.test.ts` / `query.test.ts`: 1 001 ops → `{ok:false, error:{op_index:-1, code:'invalid_param', details:{limit:1000}}}`; 1 000 `create_entity` ops succeed.
  - `contract-request.test.ts` (no DB):
    - every op schema's `examples[0]` passes `validateApplyRequest({ops:[ex]})` / `validateQueryRequest`; every schema has a non-empty `description`; the key sets of `APPLY_OPS` / `QUERY_OPS` equal the handler tables (export `APPLY_OP_NAMES`/`QUERY_OP_NAMES` from `api/apply.ts` / `api/query.ts` as `Object.keys(HANDLERS)`).
    - spec 10.1 example batch (with `add_evidence chat_message`) → `null`.
    - errors: `{}` → `op_index -1`, `field 'ops'`; `{ops: []}` → `field 'ops'`; `{ops:[{op:'frobnicate'}]}` → `op_index 0`, `details.op 'frobnicate'`; second op `{op:'add_property', entity:'bob', property:'x', value:1, time:{axis:5}}` → `op_index 1`, `field 'time.axis'`; `{op:'neighbors', entity:'bob', depth:'2'}` → `field 'depth'`; `{op:'create_entity', key:'bob', entity_key:'x'}` → `invalid_param` naming `entity_key` in `details.reason`; `{op:'get_entity', key:'bob', as:'x'}` → `invalid_param` (no `as` on query ops).
    - equivalence (R33), each must return `null` (left to the handlers): `create_entity {key:'$x'}`, `create_relation_type {name:'', description:'d', directed:true}`, `add_property {…, evidence: 0}`, `{…, evidence: 1.5}`, `add_property {…, time:{axis:'game_day', from:null}}`, `find_entities {query:'b', limit: 500}`, `add_property {entity:'bob', property:'nick', value:null}`.
- [ ] **Step 2: Run** `npx vitest run packages/sdk/test/sdk.test.ts packages/server/test/contract-request.test.ts packages/server/test/time.test.ts packages/server/test/apply.test.ts packages/server/test/query.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the sdk list, `limits.ts` + the cap in `apply()`/`query()`, the R34 check in `time.ts` (one helper used by all five parse paths), the schemas with R35 descriptions/examples, the validator; add `internal`, `timeout` to the spec 10.1 code list.
- [ ] **Step 4: Run** the same files, then `npm test` and `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** the files above: `feat: JSON Schema request contract, validator, null time rule, op cap`.

### Task 3: Response contract and conformance

**Files:**
- Create: `packages/server/src/contract/responses.ts`, `packages/server/src/contract/index.ts`
- Modify: `packages/server/src/index.ts` (export `getContract`, `validateApplyRequest`, `validateQueryRequest`, `MAX_OPS`)
- Test: `packages/server/test/contract-e2e.test.ts`

**Interfaces:**
- Consumes: Task 2 (`APPLY_OPS`, `QUERY_OPS`, request schemas, `ERROR_CODES`).
- Produces:
  - `apiErrorSchema` (`{op_index: integer ≥ -1, code: enum ERROR_CODES, message: string, details?: object}`), `applyResponseSchema` / `queryResponseSchema` (`oneOf` `{ok: true, results: array}` / `{ok: false, error}`), `APPLY_RESULTS: Record<ApplyOpName, JsonSchema>`, `QUERY_RESULTS: Record<QueryOpName, JsonSchema>` — derived from what the handlers return today (`toApi` output for apply; the field-by-field mappers in `query.ts`), `additionalProperties` left open, user/plugin data (`value`, `payload`, schemas, axis values) as `{}`.
  - `export interface Contract { version: string; apply: JsonSchema; query: JsonSchema; responses: { apply: JsonSchema; query: JsonSchema; results: { apply: Record<string, JsonSchema>; query: Record<string, JsonSchema> } }; error: JsonSchema; error_codes: readonly string[] }`
  - `export function getContract(): Contract` (`version: '1.0.0'`; the same object on every call).

- [ ] **Step 1: Write the failing e2e** `contract-e2e.test.ts` (`startRemora` with the core plugin, fake importer as in `facts-e2e.test.ts`): one scenario that runs **every** apply op and **every** query op at least once (reuse the spec 10.1 batch, then events, `end_*`, `retract_*`, `update_event`, and one `paths:true` `neighbors`). For each request: `validate*Request(req)` is `null`; the response validates against `responses.apply|query`; each `results[i]` validates against `results.apply|query[op]` (ajv with `strict:false`). Error responses: an `unknown_entity` batch validates against `responses.apply` and `error`. `getContract()` is JSON-serialisable (`JSON.parse(JSON.stringify(c))` deep-equals `c`) and `error_codes` equals `ERROR_CODES`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/contract-e2e.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `responses.ts`, `index.ts`, exports (fix result schemas until every real result validates; never loosen a request schema to pass).
- [ ] **Step 4: Run** the file + `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit**: `feat: response contract and conformance test`.

### Task 4: Startup hardening

**Files:**
- Modify: `packages/server/src/app.ts`, `packages/server/src/db/migrate.ts`, `packages/server/src/plugins/registry.ts`, `packages/server/src/api/apply.ts` (`mapPgError` 57014)
- Test: `packages/server/test/app.test.ts`, `packages/server/test/registry.test.ts`, `packages/server/test/migrate.test.ts` (extend)

**Interfaces:**
- Produces:
  - `runMigrations(db: pg.Pool | pg.PoolClient, dir?: string): Promise<string[]>` — a `Pool` behaves as today; a client runs each migration's `BEGIN … COMMIT` on itself.
  - `StartOptions` gains `statementTimeoutMs?: number` (pool `statement_timeout`, R41; omitted = server default) and `pluginsDir?: string` (used in Task 5).
  - `RemoraApp.close()` idempotent (R43); startup under the advisory lock (R39).
  - `app.ts` statically imports `@remora/core-plugin`; when `opts.importer` is absent the importer returns that module for `'@remora/core-plugin'` (Task 5 adds the directory fallback; until then other specs use the current dynamic `import`).
  - `loadPlugins` applies R38 (name check, duplicate names, clash) before upserts, inside the per-plugin `try`.
  - `mapPgError({code:'57014'})` → `RemoraError('timeout', …)`.

- [ ] **Step 1: Write failing tests.**
  - `app.test.ts`: `startRemora({databaseUrl})` **without** `importer` → axes `game_day, real, story`; two `startRemora` started with `Promise.all` on one fresh DB (repeat 3 times with fresh DBs) → both resolve, `schema_migration` has 2 rows, `plugin` has 1 row; `close()` twice → second resolves; `statementTimeoutMs: 100` → `app.pool.query('SELECT pg_sleep(1)')` rejects with `code '57014'`; `mapPgError({code:'57014'})?.code === 'timeout'`.
  - `registry.test.ts` (importer fakes): stored row `p2` whose package exports `name: 'other'` → status `{name:'p2', ok:false}` with `invalid_plugin` in `error`, its previously registered axis → `axis_unavailable`; a plugin declaring axis `day` already owned by plugin `p1` → `p2` degraded with `name_taken` in `error`, `getAxis('day')` still served by `p1`, and **no** row of `p2`'s other axes was upserted; a setup result with two axes named `x` → `invalid_plugin`; core plugin declaring an axis owned by another plugin → `loadPlugins` rejects with `name_taken`.
  - `migrate.test.ts`: `runMigrations(client)` with a pool client applies both migrations once.
- [ ] **Step 2: Run** the three files; expect FAIL.
- [ ] **Step 3: Implement** (R38 check order: name → setup → duplicate names → ownership of every name; then upserts).
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit**: `fix: startup lock, plugin name and clash checks, idempotent close, statement timeout`.

### Task 5: Plugin directory loading (spec 13, open question 1)

**Files:**
- Create: `packages/server/src/plugins/resolve.ts`
- Modify: `packages/server/src/app.ts` (default importer = static core + `pluginImporter(opts.pluginsDir ?? join(process.cwd(), 'plugins'))`; `RemoraApp.addPlugin`)
- Test: `packages/server/test/plugin-dir.test.ts`

**Interfaces:**
- Consumes: Task 4 static core import and `StartOptions.pluginsDir`.
- Produces:
  - `export function pluginImporter(pluginsDir: string): Importer` (R37; returns the module's `default` export, like today's default importer).
  - `RemoraApp.addPlugin(a: { package: string }): Promise<{ id: number; name: string }>` (uses the app's importer; existing `addPlugin` service).
  - `RemoraApp.importer: Importer` (Task 8 needs it for `set_plugin_config`).

- [ ] **Step 1: Write failing tests** — fixtures written per test into `mkdtemp(join(tmpdir(), 'remora-plugins-'))`, plain ESM JS, no imports:
  - `node_modules/remora-plugin-moon/package.json` (`{"name":"remora-plugin-moon","type":"module","exports":"./index.js"}`) + `index.js` exporting `{name:'moon', configSchema:{type:'object'}, defaultConfig:{}, setup: () => ({timeAxes:[{name:'moon_phase', description:'Moon phase.', valueSchema:{type:'integer'}, example:1, encode: (v) => BigInt(v), decode: (n) => Number(n)}]})}`.
  - `local/sun.js` exporting a plugin `sun` with axis `sun_day`; `pkgdir/package.json` with `"main": "main.js"` exporting plugin `star`.
  - Tests: `startRemora({databaseUrl, pluginsDir})` then `app.addPlugin({package:'remora-plugin-moon'})` → `{name:'moon'}`, `plugin.package` row is `'remora-plugin-moon'`; restart → `app.registry.getAxis('moon_phase')` works and `apply` with `time:{axis:'moon_phase', from:1}` succeeds. `addPlugin({package:'./local/sun.js'})` and `{package:'./pkgdir'}` work the same way. `addPlugin({package:'nope'})` → `invalid_plugin`; adding `moon` twice → `name_taken`.
  - Degradation (Review Focus 4): register `moon`, restart, delete its directory, restart → start succeeds, `registry.status()` has `{name:'moon', ok:false}`, `moon_phase` → `axis_unavailable`, `game_day` writes still work. A module that throws at import time (`throw new Error('boom')` at top level) → same degradation.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/plugin-dir.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `resolve.ts` and the app wiring.
- [ ] **Step 4: Run** the file, `app.test.ts`, `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit**: `feat: plugin directory loading by path or package name`.

### Task 6: HTTP transport

**Files:**
- Create: `packages/server/src/log.ts`, `packages/server/src/http/secret.ts`, `packages/server/src/http/body.ts`, `packages/server/src/http/status.ts`, `packages/server/src/http/server.ts`, `packages/server/src/transport/dispatch.ts`
- Test: `packages/server/test/http.test.ts`, `packages/server/test/secret.test.ts`

**Interfaces:**
- Consumes: Task 2 validators and `MAX_OPS`, Task 3 `getContract`, `RemoraApp`.
- Produces:
  - `log.ts`: `type LogLevel = 'debug' | 'info' | 'warn' | 'error'`; `interface JsonLogger extends Logger { debug(msg: string, meta?: Record<string, unknown>): void; info(msg: string, meta?: Record<string, unknown>): void }`; `createLogger(opts?: { level?: LogLevel; write?: (line: string) => void }): JsonLogger` (R42; default writes to `process.stdout`).
  - `secret.ts`: `generateSecret(): string`, `isValidSecret(s: string): boolean`, `secretMatches(candidate: string, secret: string): boolean` (R29).
  - `body.ts`: `readJsonBody(req: http.IncomingMessage, limit: number): Promise<unknown>` throwing `HttpError` (`class HttpError extends Error { status: number; code: ErrorCode }`) for 413/400/415. It counts bytes as they arrive (a `Content-Length` above the limit fails before reading); past the limit it stops buffering, and the server answers 413 with `Connection: close` and closes the socket after the response, so an oversized upload cannot hold memory or the connection.
  - `status.ts`: `statusFor(code: ErrorCode): number` (R31 table).
  - `dispatch.ts`: `runApply(app: RemoraApp, body: unknown): Promise<ApplyResponse>` and `runQuery(app: RemoraApp, body: unknown): Promise<QueryResponse>` — validator error → `{ok:false, error}` without touching the DB; else `app.apply`/`app.query`.
  - `server.ts`: `interface HttpOptions { secret: string; adminSecret?: string; maxBodyBytes: number; requestTimeoutMs: number; shutdownTimeoutMs: number }`; `createHttpServer(app: RemoraApp, opts: HttpOptions, logger: JsonLogger): RemoraHttpServer` with `interface RemoraHttpServer { server: http.Server; listen(port: number, host?: string): Promise<AddressInfo>; shutdown(): Promise<void> }` (R31, R36, R42, R43; `shutdown()` does not call `app.close()` — `main.ts` does). Routing parses the path into segments and compares the first segment with `secretMatches`; route table is extendable (Tasks 7, 8 add `mcp` and `admin`).

- [ ] **Step 1: Write failing tests.**
  - `secret.test.ts`: `generateSecret()` matches `/^[A-Za-z0-9_-]{43}$/` and two calls differ; `isValidSecret` false for 42 chars, `+`/`/` chars, empty; `secretMatches` true/false incl. different lengths.
  - `http.test.ts` (app on a fresh DB via `startRemora` + fake core importer; server on port 0; a capturing logger):
    - `POST /<s>/apply` spec 10.1-style batch → 200 `ok:true`; `POST /<s>/query` `get_entity bob` → 200; `GET /<s>/schema` → 200 and deep-equals `getContract()`; `GET /health` → 200 `{status:'ok'}`.
    - statuses: `unknown_entity` → 404; `single_valued_conflict` → 409; schema error → 400 with `op_index` and `details.field`; `axis_unavailable` (registry fake or degraded plugin) → 503.
    - Review Focus 1: `/<s>x/apply`, `/<S upper>/apply`, `//apply`, `/apply` → 404 envelope `not_found`, same body as `/nope`; no captured log line contains the secret.
    - Review Focus 2: body `{bad`, → 400; `"str"` → 400; `[1]` → 400; 2 MiB body → 413; chunked 2 MiB body without `Content-Length` (stream via `http.request`) → 413; `Content-Type: text/plain` → 415; `GET /<s>/apply` → 405; 1 001 ops → 400 with `details.limit 1000`; after each, a normal request still succeeds.
    - `x-request-id` header on every response; an injected unexpected throw (`app.apply = async () => { throw new Error('secret detail') }`) → 500 `code 'internal'`, body does not contain `secret detail`, `details.request_id` equals the header.
    - access log: one `info` line `msg 'request'` per request with `route '/:secret/apply'`, `status`, `ms`.
    - Review Focus 5: an `app.query` wrapped to wait on a promise the test controls; start it on a `new http.Agent({keepAlive: true, maxSockets: 2})` after warming a second socket with a `/health` call, call `shutdown()`, a new `/<s>/query` on the warm socket → 503 `shutting_down`; release the in-flight one → 200; `shutdown()` resolves; `/health` during shutdown → 503 `{status:'shutting_down'}`.
    - health with the pool ended (`await app.pool.end()` in a dedicated test) → 503 `{status:'unavailable'}`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/secret.test.ts packages/server/test/http.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the modules.
- [ ] **Step 4: Run** both files + `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit**: `feat: HTTP transport with secret URL, limits, status mapping, logging, shutdown`.

### Task 7: MCP transport

**Files:**
- Modify: `packages/server/package.json` (`"@modelcontextprotocol/sdk": "1.32.1"`), `package-lock.json`, `packages/server/src/http/server.ts` (route `mcp`)
- Create: `packages/server/src/mcp/server.ts`
- Test: `packages/server/test/mcp.test.ts`

**Interfaces:**
- Consumes: Task 6 `runApply`/`runQuery`, route table; Task 2 request schemas.
- Produces:
  - `createMcpServer(app: RemoraApp): Server` (low-level `Server` from `@modelcontextprotocol/sdk/server/index.js`, `{name:'remora', version:'1.0.0'}`, capability `tools`; `ListToolsRequestSchema` → tools `apply`, `query` with `inputSchema` = `applyRequestSchema` / `queryRequestSchema` and LLM-oriented `description`s; `CallToolRequestSchema` → R27 result; unknown tool → `isError: true` with an `invalid_param` envelope).
  - `handleMcp(app: RemoraApp, req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void>` (R28: per request `new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true})`, `server.connect`, `transport.handleRequest(req, res, body)`, close both on `res` `close`).

- [ ] **Step 1: Install** `npm install @modelcontextprotocol/sdk@1.32.1 --save-exact -w @remora/server`; confirm `packages/server/package.json` has `"1.32.1"` without `^`.
- [ ] **Step 2: Write failing tests** `mcp.test.ts`:
  - In-memory (`InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/sdk/inMemory.js`, `Client` from `@modelcontextprotocol/sdk/client/index.js`): `listTools()` names `['apply','query']`; `inputSchema` deep-equals the contract request schemas; `callTool apply` with `create_entity carl` → `isError false`, `structuredContent.ok === true`, `JSON.parse(content[0].text)` deep-equals `structuredContent`.
  - Review Focus 3: `callTool query {ops:[{op:'neighbors', entity:'bob', depth:'2'}]}` → `isError true`, `structuredContent.error` `{op_index:0, code:'invalid_param', details.field:'depth'}`; `{ops:[{op:'add_property', entity:'bob', property:'nickname', value:'x', time:{axis:'game_day', from:null}}]}` → `invalid_time`; `{ops:[{entity:'bob'}]}` → `invalid_param` with `op_index 0`; `callTool` name `drop_db` → `isError true`.
  - Over HTTP (Task 6 server, `StreamableHTTPClientTransport(new URL('http://127.0.0.1:<port>/<s>/mcp'))`): `listTools` and an `apply` call succeed; the same URL with a wrong secret → the client `connect` rejects; `GET /<s>/mcp` → 405.
- [ ] **Step 3: Run** `npx vitest run packages/server/test/mcp.test.ts`; expect FAIL.
- [ ] **Step 4: Implement** `mcp/server.ts` and the route.
- [ ] **Step 5: Run** the file, `http.test.ts`, `npm run typecheck`; expect PASS.
- [ ] **Step 6: Commit** (include `package-lock.json`): `feat: MCP endpoint with apply and query tools`.

### Task 8: Operator (admin) API

**Files:**
- Create: `packages/server/src/services/plugins-admin.ts`, `packages/server/src/http/admin.ts`
- Modify: `packages/server/src/app.ts` (methods), `packages/server/src/plugins/registry.ts` (export `checkConfig`, `validateSetupResult`, `asPluginDef`), `packages/server/src/http/server.ts` (route `admin`)
- Test: `packages/server/test/plugins-admin.test.ts`, `packages/server/test/http-admin.test.ts`

**Interfaces:**
- Consumes: Task 5 `RemoraApp.importer`/`addPlugin`, R18–R20 maintenance methods, Task 6 server/route table/status mapping.
- Produces:
  - `interface PluginListRow { id: number; name: string; package: string; config: unknown; status: 'ok' | 'degraded' | 'pending_restart'; error?: string; axes: string[]; sources: string[] }`
  - `listPlugins(db: Queryable, registry: PluginRegistry): Promise<PluginListRow[]>` (ordered by id)
  - `setPluginConfig(db: Queryable, importer: Importer, a: { name: string; config: unknown; confirm?: boolean }): Promise<{ name: string; restartRequired: true }>` (R40)
  - `removePlugin(pool: pg.Pool, name: string): Promise<{ name: string; restartRequired: true }>` (R40, one transaction)
  - `RemoraApp.listPlugins()`, `setPluginConfig(a)`, `removePlugin(name)`.
  - `admin.ts`: `handleAdmin(app: RemoraApp, op: string, body: unknown): Promise<{ status: number; body: unknown }>` (R40 shapes, snake_case results; unknown op → 404 `not_found`).

- [ ] **Step 1: Write failing tests.**
  - `plugins-admin.test.ts` (core plugin + a fake plugin `p2` with axis `p2_day` via importer fakes): `listPlugins` → `remora-core` `ok` with axes `['game_day','real','story']` and sources `['chat_message']`; degraded plugin → `status 'degraded'`, `error` set; plugin added after start → `pending_restart`. `setPluginConfig remora-core` with an invalid config (`{timeAxes: 5}`) → `invalid_config`; valid config on a DB without data → stored; after a `game_day` fact exists → `invalid_param` with `details.reason 'confirm_required'`, `details.affected.axes` containing `game_day`; with `confirm:true` → stored, `restartRequired true`, and a restart loads the new config. `removePlugin('remora-core')` → `invalid_plugin`; `'nope'` → `not_found`; `p2` with a fact on `p2_day` → `invalid_param` `reason 'has_data'`; `p2` without data → its `time_axis` and `plugin` rows are gone.
  - `http-admin.test.ts`: with `adminSecret` set — `GET /<a>/admin/list_plugins` → 200 rows; `POST /<a>/admin/pin_evidence {id}` → 200, then `purge_evidence {ids:[id]}` → `{purged:0, skipped_pinned:1}`; `unpin_evidence` → purge → `purged 1`; `apply_retention {}` → report with `skipped: []`; `purge_evidence {source:'chat_message', older_than:'nope'}` → 400; `add_plugin {package:'nope'}` → 400 `invalid_plugin`; unknown op → 404; admin ops under the LLM secret (`/<s>/admin/list_plugins`) → 404; without `adminSecret` every `/admin` path → 404; `/health` → `degraded` while a plugin is degraded (Review Focus 4).
- [ ] **Step 2: Run** both files; expect FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** both files, `http.test.ts`, `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit**: `feat: operator API for plugins and evidence maintenance`.

### Task 9: Configuration, entry point and real build

**Files:**
- Create: `packages/server/src/config.ts`, `packages/server/src/main.ts`, `packages/sdk/tsconfig.build.json`, `packages/core-plugin/tsconfig.build.json`, `packages/server/tsconfig.build.json`
- Modify: `package.json` (scripts `build`, `start`, `gen-secret`; version), `packages/*/package.json` (R44 exports, version `1.0.0`), `tsconfig.base.json` (`customConditions`), `vitest.config.ts` (R44)
- Test: `packages/server/test/config.test.ts`, `packages/server/test/build-smoke.test.ts`

**Interfaces:**
- Consumes: Tasks 4–8 (`startRemora` options, `createHttpServer`, `createLogger`, `generateSecret`).
- Produces:
  - `interface RemoraConfig { databaseUrl: string; host: string; port: number; secret: string; adminSecret?: string; pluginsDir: string; maxBodyBytes: number; requestTimeoutMs: number; statementTimeoutMs: number; shutdownTimeoutMs: number; logLevel: LogLevel }`
  - `loadConfig(env: NodeJS.ProcessEnv, cwd?: string): RemoraConfig` — env names and defaults: `DATABASE_URL` (required), `HOST` `0.0.0.0`, `PORT` `8080` (integer 0–65535), `REMORA_SECRET` (required, R29), `REMORA_ADMIN_SECRET` (optional, R30), `PLUGINS_DIR` `<cwd>/plugins`, `REMORA_MAX_BODY_BYTES` `1048576`, `REMORA_REQUEST_TIMEOUT_MS` `30000`, `REMORA_STATEMENT_TIMEOUT_MS` `30000`, `REMORA_SHUTDOWN_TIMEOUT_MS` `10000`, `LOG_LEVEL` `info`. Every violation → `RemoraError('invalid_config', …, {variable})` (message names the variable, never its value).
  - `main(argv: string[], env: NodeJS.ProcessEnv): Promise<void>` — `gen-secret` prints `generateSecret()` and returns; otherwise `loadConfig` → `startRemora` → `createHttpServer().listen()` → log `info` `{msg:'listening', port}` → `SIGTERM`/`SIGINT` handlers (R43). Config/start failure → one `error` log line and `process.exitCode = 1`. The module runs `main(process.argv.slice(2), process.env)` only when it is the entry point (`import.meta.url === pathToFileURL(process.argv[1]).href`).
  - Root scripts: `"build": "tsc -p packages/sdk/tsconfig.build.json && tsc -p packages/core-plugin/tsconfig.build.json && tsc -p packages/server/tsconfig.build.json"`, `"start": "node packages/server/dist/main.js"`, `"gen-secret": "node packages/server/dist/main.js gen-secret"`.

- [ ] **Step 1: Write failing tests.**
  - `config.test.ts`: minimal env (`DATABASE_URL`, valid `REMORA_SECRET`) → defaults above; missing `DATABASE_URL` → `invalid_config` with `details.variable 'DATABASE_URL'`; short secret → `invalid_config`, message does not contain the secret; admin secret equal to the main one → `invalid_config`; `PORT: 'x'` → `invalid_config`; `LOG_LEVEL: 'loud'` → `invalid_config`.
  - `build-smoke.test.ts` (timeout 180 s): `execFileSync('npm', ['run', 'build'], {shell: true})` succeeds; `packages/server/dist/main.js`, `packages/sdk/dist/index.d.ts` exist; spawn `node packages/server/dist/main.js` with a fresh test DB URL, `PORT=0`, a generated secret, `PLUGINS_DIR` = a temp dir; read stdout lines until `msg === 'listening'` and take `port`; `GET /health` → 200; `POST /<s>/apply` `create_entity` → `ok:true`; kill the child (on `win32` assert only that it exits; elsewhere `SIGTERM` → exit code 0 within 10 s). `node packages/server/dist/main.js gen-secret` prints a line matching `/^[A-Za-z0-9_-]{43}$/`. `node packages/server/dist/main.js` without env → exit code 1 and a JSON `error` line naming `DATABASE_URL`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/config.test.ts packages/server/test/build-smoke.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** config, main, build configs, exports, vitest conditions.
- [ ] **Step 4: Run** `npm test` (whole suite must still resolve from source with and without `dist` present: run once after `npm run build` and once after deleting `packages/*/dist`), `npm run typecheck`; expect PASS. `dist` stays ignored (`.gitignore`).
- [ ] **Step 5: Commit**: `feat: env configuration, entry point and tsc build`.

### Task 10: Docker image and compose

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `README.md` (sections "Run with Docker", "Configuration", "Plugins", "MCP clients" only; Task 11 adds the rest)

**Interfaces:**
- Consumes: Task 9 build and env names.
- Produces:
  - `Dockerfile`: stage `build` `FROM node:24-bookworm-slim` → `WORKDIR /app`, copy `package.json`, `package-lock.json`, `tsconfig.base.json`, then one `COPY` line per package manifest (`COPY packages/sdk/package.json packages/sdk/` etc. — a wildcard `COPY` would flatten the paths), `npm ci`, copy `packages/`, `npm run build`, `npm prune --omit=dev`; stage `runtime` `FROM node:24-bookworm-slim` → `WORKDIR /app`, `ENV NODE_ENV=production PLUGINS_DIR=/plugins PORT=8080`, `COPY --from=build /app/package.json /app/`, `COPY --from=build /app/node_modules /app/node_modules`, `COPY --from=build /app/packages /app/packages` (manifests, `dist`, `migrations`; the workspace symlinks in `node_modules/@remora` point there); `RUN mkdir -p /plugins && chown node:node /plugins`; `VOLUME /plugins`; `USER node`; `EXPOSE 8080`; `HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`; `CMD ["node","packages/server/dist/main.js"]`.
  - `.dockerignore`: `node_modules`, `**/dist`, `.git`, `.superpowers`, `docs`, `*.html`, `*.md`, `!README.md`, `.env`.
  - `docker-compose.yml`: `db` = `postgres:18` (`POSTGRES_USER/PASSWORD/DB=remora`, volume `pgdata:/var/lib/postgresql` — the PG 18 image's data root, healthcheck `pg_isready -U remora`); `remora` = `build: .`, `environment: DATABASE_URL=postgres://remora:remora@db:5432/remora`, `REMORA_SECRET: ${REMORA_SECRET:?set REMORA_SECRET in .env}`, `REMORA_ADMIN_SECRET: ${REMORA_ADMIN_SECRET:-}`, `LOG_LEVEL`, `ports: ["${REMORA_PORT:-8080}:8080"]`, `volumes: [plugins:/plugins]`, `depends_on: db: condition: service_healthy`, `restart: unless-stopped`; volumes `pgdata`, `plugins`.
  - `.env.example` with `REMORA_SECRET=`, `REMORA_ADMIN_SECRET=`, `REMORA_PORT=8080`, a comment showing `docker run --rm node:24-bookworm-slim node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` for generating secrets.
  - README sections: env table (all Task 9 variables, defaults, meaning); secret generation; MCP config examples — Claude Code `claude mcp add --transport http remora http://localhost:8080/<secret>/mcp` and a generic JSON client entry `{"mcpServers":{"remora":{"type":"http","url":"http://localhost:8080/<secret>/mcp"}}}`; plugin flow (R37): `docker compose exec remora npm install --prefix /plugins <pkg>` → `POST /<admin>/admin/add_plugin {"package":"<pkg>"}` → `docker compose restart remora` → `GET /<admin>/admin/list_plugins`; config change with `set_plugin_config` and `confirm`; warning that `@remora/sdk` is not published (plugins export a plain object).

- [ ] **Step 1: Write the files.**
- [ ] **Step 2: Smoke run** (Docker is available in this environment; if `docker version` fails, record that in the commit message and stop after Step 1): in the worktree, with a throwaway `.env` (`REMORA_SECRET` and `REMORA_ADMIN_SECRET` generated with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`, `REMORA_PORT=18080`):
  - `docker compose -p remora-smoke up -d --build --wait` → exits 0 (both services healthy);
  - `curl -s localhost:18080/health` → `{"status":"ok"}`;
  - `curl -s -X POST -H 'content-type: application/json' -d '{"ops":[{"op":"create_entity","key":"bob"}]}' localhost:18080/$REMORA_SECRET/apply` → `"ok":true`;
  - `curl -s localhost:18080/$REMORA_ADMIN_SECRET/admin/list_plugins` → contains `remora-core`;
  - `docker compose -p remora-smoke exec remora id -u` → not `0`;
  - `docker compose -p remora-smoke down -v` and delete the throwaway `.env`.
- [ ] **Step 3: Commit** `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `README.md`: `feat: Docker image and compose setup`.

### Task 11: v1.0.0 documentation

**Files:**
- Modify: `README.md` (top part), `docs/superpowers/specs/2026-10-22-historicity-design.md` (header status, sections 2, 10, 13, 15)
- Create: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above; Rulings R27–R46.

- [ ] **Step 1: README top:** what remora is (temporal facts on several time axes, events, evidence; PostgreSQL; HTTP + MCP), quick start (`cp .env.example .env`, generate secrets, `docker compose up -d`), local development (`npm install`, `npm test` needs Docker for testcontainers, `npm run build`, `npm start`), API overview (endpoints from R31, `GET /<secret>/schema` as the authoritative contract, one `apply` and one `query` example taken from `contract-e2e.test.ts`, error envelope and status table), link to the spec.
- [ ] **Step 2: Spec edits:** header `Статус: реализовано (v1.0.0)`; section 2 — HTTP endpoints and MCP tools `apply`/`query` (R27, R28), admin secret (R30); section 10 "Контракт" — `/schema` shape (Task 3 `Contract`) and the transport-level `additionalProperties:false` (R33), null time values (R34); section 13 — plugin directory resolution (R37), per-plugin clash/name errors (R38), `set_plugin_config` / `remove_plugin` (R40); section 15 "Открыто": item 1 → closed (R37, Task 5 tests), item 2 → closed (plan 2 test "retracted row does not block"), item 3 → closed (plan 3 Task 8 measurement), item 4 → batch size 500 and order by id (plan 3 R18) closed, schedule deferred; item 5 adds R46 items; add a "Закрыто в v1" note for the hub `via` finding (R45: 92 s → 0.26 s). Text in Russian, like the rest of the spec.
- [ ] **Step 3: CHANGELOG.md** `## 1.0.0 — 2026-10-28` with Added (facts/apply/query, neighbors, events, evidence + retention, plugins + core plugin, JSON Schema contract, HTTP, MCP, operator API, Docker), Fixed (neighbors hub plan, startup race), Known limitations (R46).
- [ ] **Step 4: Verify** every env variable, route and op named in README exists in code: `npx vitest run packages/server/test/contract-e2e.test.ts packages/server/test/config.test.ts` pass and `rg -n "REMORA_|PLUGINS_DIR|DATABASE_URL|LOG_LEVEL" README.md packages/server/src/config.ts` lists the same variable names.
- [ ] **Step 5: Commit** `README.md`, `CHANGELOG.md`, the spec: `docs: v1.0.0 README, changelog and spec status`.

---

## Parked for v2

Everything in R46; per-op MCP tools if clients struggle with batch schemas; rate limiting; TLS termination (expected from a reverse proxy); multiple secrets/roles.
