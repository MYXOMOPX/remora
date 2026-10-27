# Changelog

Versions follow the git tags `v0.1.0-foundation`, `v0.2.0-facts`, `v0.3.0-graph-events-evidence`; 1.0.0 is tagged on merge of `feat/transport`. The design is in `docs/superpowers/specs/2026-10-22-historicity-design.md`, each release has an implementation plan in `docs/superpowers/plans/`.

## 1.0.0 — 2026-10-28

Transport, contract and packaging (plan 4): remora becomes a runnable service.

### Added
- JSON Schema contract for `apply`, `query`, responses and errors, hand-authored with LLM-oriented descriptions and one validated example per op. Served at `GET /<secret>/schema`; request validation at the transport boundary reports `op_index` and `details.field`. Op objects reject unknown fields. `ops` is capped at 1000 per request (also enforced in-process).
- HTTP API on `node:http` behind a secret URL: `POST /<secret>/apply`, `POST /<secret>/query`, `GET /<secret>/schema`, `GET /health`. Constant-time secret comparison, identical 404 for a wrong secret and an unknown path, body size limit (413), content-type check (415), HTTP status mapping for all error codes, `x-request-id`, JSON access log without secrets, request and header timeouts, graceful shutdown on `SIGTERM`/`SIGINT`.
- MCP endpoint (`POST /<secret>/mcp`): stateless Streamable HTTP with two tools, `apply` and `query`, whose input schema is the contract. stdio clients can bridge with `mcp-remote`.
- Operator API under a second secret (`/<admin secret>/admin/<op>`): `list_plugins`, `add_plugin`, `set_plugin_config`, `remove_plugin`, `apply_retention`, `purge_evidence`, `pin_evidence`, `unpin_evidence`.
- Plugins: plugin directory (`PLUGINS_DIR`), resolution by path or package name, per-plugin load, name and clash checks (a broken third-party plugin degrades the service instead of stopping it; `/health` reports `degraded`).
- Startup under a PostgreSQL advisory lock, so replicas starting together are serialised. `statement_timeout` (`REMORA_STATEMENT_TIMEOUT_MS`) with a typed `timeout` error.
- New error codes `internal` (unexpected transport failure) and `timeout`.
- Explicit `null` as a time bound is `invalid_time` (omit the bound instead).
- Environment configuration, `gen-secret` command, `tsc` build with `dist/` output and a `remora-source` export condition for development, Dockerfile (non-root, Node 24), `docker-compose.yml` with PostgreSQL 18, volumes for data and plugins, a Docker smoke script.
- Root README with concepts, quick start, API overview, security model, backup, upgrade and plugin operations.

### Fixed
- `neighbors` on a graph with a hub (50 000 edges, no `ANALYZE`) took 92 s because the planner nested the level set inside each hub edge; the `via` step now finds edges from the page side through the existing indexes and hash-joins the level set: 0.26 s, independent of statistics.
- Startup race between replicas (migrations, core plugin registration, plugin load) is serialised by the advisory lock; `close()` is idempotent.
- Plugin loading no longer relies on `import.meta.resolve` with a parent URL (ignored by plain Node); packages are looked up in `<PLUGINS_DIR>/node_modules` manually.
- A plugin whose package name differs from its stored row, or that declares an axis or source owned by another plugin, is rejected before anything is written.

### Notes for upgrading and operating
- Security defaults: the service listens on `127.0.0.1` unless `HOST` is set (the image sets `0.0.0.0`); compose publishes the port on `127.0.0.1` only and takes the database password from `POSTGRES_PASSWORD` in `.env` (required). `.env` files are git-ignored.
- HTTP statuses: `408` when the request body is not received within `REMORA_REQUEST_TIMEOUT_MS`; `GET /health` answers `503` with `{"status":"unavailable"}` when the database is unreachable. Request bodies nested deeper than 64 levels are `400 invalid_param`. JSON-RPC batch arrays on the MCP route are rejected (`-32600`).
- New settings `REMORA_DB_CONNECT_TIMEOUT_MS` (default 10000) and `REMORA_MAX_CONNECTIONS` (default 1024).
- The shutdown 503 (requests arriving after `SIGTERM`) uses the code `internal` with `details.reason: "shutting_down"`.
- `set_plugin_config` validates the config against the module already loaded in memory; a newer package version on disk is seen only after a restart. A plugin is listed as `pending_restart` by name when its row was added after the process loaded plugins.
- Installations created before 1.0.0 keep the core plugin config stored in their database, which has no `chat_message` evidence source; `add_evidence source: "chat_message"` works only on fresh installs unless the stored config of `remora-core` is extended with that source through `set_plugin_config` (not yet verified on an upgraded database).
- Ajv in the contract validator is strict; the schemas are the documentation of every op for LLM clients.

### Known limitations (deferred to v2)
- `apply_retention` is manual; there is no scheduler.
- MCP over stdio and per-op MCP tools (clients use the HTTP URL; the two batch tools keep atomicity and `$name` references).
- `@remora/sdk` is not published; third-party plugins are plain ES modules.
- No hot plugin reload; plugin changes need a restart. Plugins are not installed from the admin API (run `npm install --prefix "$PLUGINS_DIR"`).
- No migration of existing data when a plugin config changes (axis re-encoding, repeated retention); the admin API only asks for `confirm: true`.
- No rate limiting, no TLS termination (use a reverse proxy), one secret and no roles.
- Relations between events, filters and aggregates in `neighbors`, `deprecate_type` and aliases, `set_property_span`, "now" of an axis in `list_time_axes`.

## 0.3.0 — 2026-10-27 (`v0.3.0-graph-events-evidence`)

### Added
- `neighbors`: level-by-level traversal up to 6 steps with a time filter at every step, `via` and `via_count`, property `include`, `order_by`, `limit` with `total`/`truncated`, and `paths: true` (capped at 10 000, `too_many_paths`).
- Events: `add_event`, `update_event`, `retract_event`, `get_event`, `search_events` (keywords, text, participants, time), `entity_events`, `list_event_roles`.
- Evidence: `add_evidence` through plugin sources, `get_evidence`, `list_evidence_sources`, declarative sources and retention stages in the core plugin, `apply_retention` (batches of 500 ordered by id), purge and pin services.

### Fixed
- Hardening of evidence maintenance against hostile plugins and raw database errors; strict event time keys; empty event search filters rejected.

## 0.2.0 — 2026-10-27 (`v0.2.0-facts`)

### Added
- `apply` batch engine: one transaction per batch, `as`/`$name` references, `op_index` in errors.
- Properties (`add_property`, `replace_property`, `end_property`, `retract_property`) with single- and multi-valued types and the `timeless_conflict` rule; relations (`add_relation`, `end_relation`, `retract_relation`) with a logical `relation_id` shared by axis rows.
- `query` engine: `get_entity`, `find_entities`, `property_at`, `property_history`, `relation_history`, dictionary reads, `list_time_axes`; `when` with `at` and `during`.
- Time parsing and plugin-owned encoding; typed errors for COMMIT and class-22 database errors.

## 0.1.0 — 2026-10-26 (`v0.1.0-foundation`)

### Added
- Monorepo with `@remora/sdk`, `@remora/core-plugin` and `@remora/server`.
- PostgreSQL schema (entities, dictionaries, time axes, property and relation versions, events, evidence, plugins) with constraint tests, and a migration runner.
- `remora-core` plugin with `integer`, `datetime` and `packed` time axes; plugin registry with degraded startup; entity and dictionary services; `startRemora` bootstrap.
