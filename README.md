# remora

Memory service for LLM agents. It stores **facts** about entities with their history on several time axes at once (real time, game days, story chapters, ...), **events** (free-form observations with keywords, participants and time) and optional **evidence** (the raw material facts were derived from). Everything lives in one PostgreSQL database; clients talk to it over a secret-URL HTTP API or MCP. The service contains no LLM: the caller decides what to write and how to deduplicate types.

Version 1.0.0. Design: [`docs/superpowers/specs/2026-10-22-historicity-design.md`](docs/superpowers/specs/2026-10-22-historicity-design.md) (Russian). Implementation plans: [`docs/superpowers/plans/`](docs/superpowers/plans/) (foundation, facts, graph/events/evidence, transport). History: [`CHANGELOG.md`](CHANGELOG.md).

## Concepts

- **Entity**: a thing with a unique text `key` (`bob`, `google`). It must be created with `create_entity` before other ops may use it.
- **Property**: a typed value of an entity (`job_title`, `height`). A property type is `single_valued` (one value at a time, e.g. a job title) or multi-valued (e.g. nicknames), with a `value_type` of `number`, `text`, `date`, `bool` or `json`.
- **Relation**: a link between two entities (`bob works_at google`), directed or symmetric. Several relations of one type may hold at the same time.
- **Time axis**: a named scale on which facts are valid. The built-in `remora-core` plugin provides `game_day` (integer), `real` (ISO-8601 with time zone) and `story` (`{tome, chapter, scene}`); more axes come from plugins. A fact carries `(axis, [from, to))`, half-open, and both bounds are optional (omitted = unbounded). A fact without any time is timeless and is current at every query time. "Now" is not stored; the caller passes it as `when`. An explicit `null` bound is an error (`invalid_time`): omit the bound instead.
- **Event**: a self-contained observation ("Bob got promoted at the party") with a summary, keywords, time on at least one axis (instant `at`, or a span `from`/`to`) and participants with roles. Events can be edited in place and retracted.
- **Evidence**: the raw source (for example a chat message) behind facts and events, written through a plugin-defined source (`chat_message` ships with the core plugin). Retention is owned by the source plugin and is run by the operator; evidence can be aged, purged or pinned, so summaries must stand on their own.
- Rows are never deleted: wrong facts are **retracted** and are hidden from reads unless `include_retracted: true`.

## Quick start

```bash
cp .env.example .env
# put two different generated secrets into REMORA_SECRET and REMORA_ADMIN_SECRET (see "Secret generation")
docker compose up -d --build --wait
curl -s localhost:8080/health          # {"status":"ok"}
```

The next section has the details (a first request, backup, upgrade, shutdown); the API overview shows the calls.

## Local development

Requirements: Node.js 24, Docker (the tests start PostgreSQL 18 through testcontainers).

```bash
npm install
npm test               # all packages; needs Docker
npm run typecheck
npm run build          # sdk -> core-plugin -> server, output in packages/*/dist
DATABASE_URL=postgres://user:pass@localhost:5432/remora REMORA_SECRET=$(npm run -s gen-secret) npm start
```

Packages: `@remora/sdk` (types, error codes, plugin shapes), `@remora/core-plugin` (declarative axes and sources), `@remora/server` (services, contract, HTTP, MCP, admin). During development and tests packages resolve from `src` through the `source` export condition; `node` uses `dist`.

## API overview

All LLM-facing calls are batches: a JSON object `{"ops": [...]}` of 1 to 1000 ops. `apply` runs its ops in order in one transaction (any error rolls everything back); an op may declare `"as": "name"` and later ops refer to its result as `"$name"` (entities and evidence). `query` runs read ops and returns the results in order.

| Endpoint | Purpose |
|---|---|
| `POST /<secret>/apply` | write ops |
| `POST /<secret>/query` | read ops |
| `GET /<secret>/schema` | the contract: JSON Schemas for requests, responses and errors, with descriptions and examples written for an LLM. This is the authoritative reference for every op and field. |
| `POST /<secret>/mcp` | the same two operations as MCP tools |
| `GET /health` | `ok`, `degraded` (a plugin failed to load), `unavailable` or `shutting_down` (both 503) |
| `POST /<admin secret>/admin/<op>` | operator API (see "Plugins") |

Write ops (`apply`): `create_entity`, `create_property_type`, `create_relation_type`, `add_property`, `replace_property`, `end_property`, `retract_property`, `add_relation`, `end_relation`, `retract_relation`, `add_event`, `update_event`, `retract_event`, `add_evidence`.
Read ops (`query`): `get_entity`, `find_entities`, `property_at`, `property_history`, `relation_history`, `neighbors`, `list_relation_types`, `find_relation_types`, `list_property_types`, `find_property_types`, `list_time_axes`, `get_event`, `search_events`, `entity_events`, `list_event_roles`, `list_evidence_sources`, `get_evidence`.

Requests are strictly validated: unknown fields are rejected (`invalid_param` with `details.field`), so a typo such as `entity_key` is reported rather than ignored. The schemas are the documentation; fetch `/schema` instead of guessing. The examples below were run against a fresh database; ids count from 1 there.

### Facts: apply and query

`replace_property` closes the open value at `at` and opens the new one, so the history stays queryable.

```bash
curl -s -X POST -H 'content-type: application/json' localhost:8080/$REMORA_SECRET/apply -d '{"ops":[
  {"op":"create_entity","key":"bob"},
  {"op":"create_entity","key":"google"},
  {"op":"create_property_type","name":"job_title","description":"Job title.","value_type":"text","single_valued":true},
  {"op":"create_relation_type","name":"works_at","description":"Employment.","directed":true},
  {"op":"add_evidence","as":"e1","source":"chat_message","payload":{"text":"Bob got promoted"}},
  {"op":"replace_property","entity":"bob","property":"job_title","value":"Junior","time":{"axis":"game_day","at":100},"evidence":"$e1"},
  {"op":"replace_property","entity":"bob","property":"job_title","value":"Senior","time":{"axis":"game_day","at":292},"evidence":"$e1"},
  {"op":"add_relation","type":"works_at","from":"bob","to":"google","time":{"axis":"game_day","from":292},"evidence":"$e1"}
]}'
```

```json
{"ok":true,"results":[{"key":"bob","created":true},{"key":"google","created":true},
 {"id":1,"name":"job_title","description":"Job title.","value_type":"text","single_valued":true},
 {"id":1,"name":"works_at","description":"Employment.","directed":true},
 {"id":1,"as":"e1"},
 {"closed":[],"retracted":[],"ids":[1]},
 {"closed":[1],"retracted":[],"ids":[2]},
 {"relation_id":1,"ids":[1]}]}
```

The second `replace_property` closed row 1 and created row 2. Reading the value at two moments:

```bash
curl -s -X POST -H 'content-type: application/json' localhost:8080/$REMORA_SECRET/query -d '{"ops":[
  {"op":"property_at","entity":"bob","property":"job_title","when":{"axis":"game_day","at":150}},
  {"op":"property_at","entity":"bob","property":"job_title","when":{"axis":"game_day","at":300}}
]}'
```

```json
{"ok":true,"results":[
 {"rows":[{"id":1,"value":"Junior","time":{"axis":"game_day","from":100,"to":292},"evidence_id":1,"recorded_at":"2026-10-27T06:13:43.100Z"}]},
 {"rows":[{"id":2,"value":"Senior","time":{"axis":"game_day","from":292},"evidence_id":1,"recorded_at":"2026-10-27T06:13:43.100Z"}]}]}
```

`when` is `{"axis", "at"}` (current at a moment) or `{"axis", "during": [a, b]}` (overlapping a span); without `when` all versions are returned, each with its own `time`.

### Graph: neighbors

`neighbors` walks relations up to 6 steps, filtering by time at every step, and returns each reachable entity once with its minimal `depth` and the edge it was reached by (`via`). `include` pulls properties; `order_by` and `limit` apply to the entities; the answer carries `total` and `truncated` (there is no pagination: narrow the query when `truncated` is true). Setup (an `apply` batch run beforehand): `create_entity carl`, `create_property_type {name: "height", value_type: "number", single_valued: true, ...}`, `create_relation_type {name: "friend_of", directed: false, ...}`, `add_relation {type: "friend_of", from: "bob", to: "carl"}`, `add_property {entity: "carl", property: "height", value: 186}`. Together with the `works_at` relation above, "the tallest friend of Bob" is:

```bash
curl -s -X POST -H 'content-type: application/json' localhost:8080/$REMORA_SECRET/query -d '{"ops":[
  {"op":"neighbors","entity":"bob","depth":1,"include":["height"],"order_by":{"property":"height","dir":"desc"},"limit":1}
]}'
```

```json
{"ok":true,"results":[{"rows":[{"entity":"carl","depth":1,"via":{"relation":"friend_of","from":"bob","relation_id":2,"time":null},"via_count":1,"properties":{"height":[186]}}],"total":2,"truncated":true}]}
```

`total` is 2 because bob also reaches `google` through `works_at`; `truncated` is true because `limit` was 1. `paths: true` returns full paths instead of `via` and is capped at 10 000 paths (`too_many_paths`).

### Events and evidence

```bash
curl -s -X POST -H 'content-type: application/json' localhost:8080/$REMORA_SECRET/apply -d '{"ops":[
  {"op":"add_event","summary":"Bob got promoted at the party","keywords":["promotion","party"],
   "time":{"axis":"game_day","at":292},"entities":[{"entity":"bob","role":"actor"}]}
]}'
# {"ok":true,"results":[{"id":1}]}
curl -s -X POST -H 'content-type: application/json' localhost:8080/$REMORA_SECRET/query -d '{"ops":[
  {"op":"search_events","keywords":["promotion"],"entities":["bob"]},
  {"op":"get_evidence","id":1}
]}'
```

`search_events` returns `{"rows":[{"id":1,"summary":"Bob got promoted at the party","details":null,"keywords":["promotion","party"],"time":[{"axis":"game_day","at":292}],"entities":[{"entity":"bob","role":"actor"}],"evidence_id":null,"recorded_at":"...","updated_at":null}],"total":1,"truncated":false}`; `get_evidence` returns `{"id":1,"source":"chat_message","payload":{"text":"Bob got promoted"},"created_at":"...","purged_at":null,"pinned":false}`.

### Errors

Failure envelope (the whole batch is rolled back; `op_index` is the failing op, `-1` for problems with the request itself):

```json
{"ok":false,"error":{"op_index":1,"code":"unknown_entity","message":"unknown entity: nobody","details":{"key":"nobody"}}}
```

| HTTP status | Codes |
|---|---|
| 200 | `ok: true` |
| 400 | `invalid_param`, `invalid_time`, `invalid_name`, `invalid_payload`, `value_type_mismatch`, `unknown_ref`, `invalid_config`, `invalid_plugin` |
| 404 | `not_found`, `unknown_entity`, `unknown_type`, `unknown_axis`, `unknown_source`; also any wrong secret or unknown path |
| 405 / 413 / 415 | wrong method / body above `REMORA_MAX_BODY_BYTES` / `Content-Type` is not `application/json` (envelope code `invalid_param`) |
| 409 | `single_valued_conflict`, `timeless_conflict`, `name_taken`, `concurrent_update` (retry the batch) |
| 422 | `too_many_paths` |
| 500 | `internal` (unexpected failure; the stack is only in the server log, `details.request_id` correlates) |
| 503 | `axis_unavailable`, `source_unavailable` (plugin failed to load); during shutdown `internal` with `details.reason: "shutting_down"` |
| 504 | `timeout` (PostgreSQL `statement_timeout`; the batch was rolled back, narrow the request) |

Every response carries an `x-request-id` header.

## Security model

- **Secret URL.** There are no users and no tokens: whoever knows `REMORA_SECRET` can read and write everything in the database (one secret = one database, no roles). The secret is a path segment of at least 43 characters of `[A-Za-z0-9_-]`, compared in constant time; a wrong or missing secret gets the same 404 as an unknown path. Secrets and request bodies are not logged (the access log writes the route as `/:secret/apply`). Treat the URL like a password.
- **Admin secret.** Operator ops (plugins, evidence retention, purge, pin) live under a second, different secret, `REMORA_ADMIN_SECRET`, at `/<admin secret>/admin/<op>`. If it is unset the admin API is disabled. It is not exposed through MCP; give LLM clients only the LLM URL.
- **Transport.** The service speaks plain HTTP and the secret is part of the URL, so terminate TLS in a reverse proxy and do not expose the port to untrusted networks. The compose file publishes `REMORA_PORT` on all host interfaces; restrict it with a firewall, or change the mapping to `127.0.0.1:${REMORA_PORT:-8080}:8080` when the proxy runs on the same host. The database port is not published.
- **Plugin trust.** A plugin is Node.js code loaded into the service process and runs with its privileges (no sandbox). Install only packages you trust. The admin API only registers packages that are already installed in the plugin directory.
- There is no rate limiting in v1 (a reverse proxy can add it).

## Run with Docker

Requirements: Docker with the Compose plugin.

```bash
cp .env.example .env
# generate two different secrets and put them into .env (see "Secret generation")
docker compose up -d --build --wait
curl -s localhost:8080/health          # {"status":"ok"}
```

Compose starts `db` (PostgreSQL 18, volume `pgdata`) and `remora` (non-root user, port `REMORA_PORT`, default 8080, plugins volume `plugins` mounted at `/plugins`). Migrations and the core plugin are applied at start; two replicas starting together are serialised by an advisory lock.

Try it (`$REMORA_SECRET` is the value from `.env`):

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"ops":[{"op":"create_entity","key":"bob"}]}' localhost:8080/$REMORA_SECRET/apply
curl -s localhost:8080/$REMORA_SECRET/schema      # the JSON Schema contract
```

Endpoints: `POST /<secret>/apply`, `POST /<secret>/query`, `GET /<secret>/schema`, `POST /<secret>/mcp`, `GET /health` (no secret), operator API under `/<admin secret>/admin/<op>`. A wrong or missing secret returns the same 404 as an unknown path. TLS is expected from a reverse proxy; the secret is part of the URL, so do not expose the port over plain HTTP outside a trusted network.

Smoke test of the whole image (build, HTTP, MCP, plugin flow, graceful `docker stop`; removes everything it creates; not part of `npm test`): `bash scripts/docker-smoke.sh`.

### Backup

All state is in PostgreSQL (volume `pgdata`) plus installed plugins (volume `plugins`):

```bash
docker compose exec -T db pg_dump -U remora remora > remora-backup.sql
docker run --rm -v remora_plugins:/plugins -v "$PWD":/out busybox tar czf /out/plugins.tgz -C /plugins .
```

(The plugins volume is named `<compose project>_plugins`; check with `docker volume ls`.) Restore with `psql` into an empty database.

### Upgrade

```bash
git pull
docker compose up -d --build --wait
```

Migrations run automatically at start under the advisory lock. Take a backup first. Plugins in the `plugins` volume survive rebuilds.

### Graceful shutdown

On `SIGTERM`/`SIGINT` the service stops accepting, answers new requests on open connections with 503, waits for in-flight requests up to `REMORA_SHUTDOWN_TIMEOUT_MS`, closes the pool and exits 0. `docker compose stop` / `docker stop` use this path (Node is PID 1 and handles the signal itself).

## Configuration

All configuration is by environment variable. Compose reads `REMORA_SECRET`, `REMORA_ADMIN_SECRET`, `REMORA_PORT` and `LOG_LEVEL` from `.env`; to set other variables add them to the `remora` service `environment` in `docker-compose.yml`.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required (set by compose) | PostgreSQL connection string. |
| `REMORA_SECRET` | required | Secret path segment of the LLM API. At least 43 chars of `[A-Za-z0-9_-]`. |
| `REMORA_ADMIN_SECRET` | unset | Secret path segment of the operator API; same format, must differ from `REMORA_SECRET`. Unset disables `/admin` routes. |
| `PORT` | `8080` | Listen port inside the container. |
| `HOST` | `0.0.0.0` | Listen address. |
| `REMORA_PORT` | `8080` | Host port published by compose. |
| `PLUGINS_DIR` | `/plugins` in the image, `<cwd>/plugins` otherwise | Where plugins are installed. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. JSON lines on stdout. |
| `REMORA_MAX_BODY_BYTES` | `1048576` | Maximum request body; larger gives 413. |
| `REMORA_REQUEST_TIMEOUT_MS` | `30000` | HTTP request timeout. |
| `REMORA_STATEMENT_TIMEOUT_MS` | `30000` | PostgreSQL `statement_timeout`; `0` disables. A timed-out batch is rolled back (`timeout`). |
| `REMORA_SHUTDOWN_TIMEOUT_MS` | `10000` | How long shutdown waits for in-flight requests. |

### Secret generation

Each secret is 32 random bytes in base64url. Without a checkout:

```bash
docker run --rm node:24-bookworm-slim node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

From a built checkout: `npm run gen-secret`; from a running container: `docker compose exec remora node packages/server/dist/main.js gen-secret`. Generate one for `REMORA_SECRET` and a different one for `REMORA_ADMIN_SECRET`. Never commit `.env`.

## MCP clients

The MCP endpoint is Streamable HTTP (stateless) at `http://localhost:8080/<secret>/mcp` and exposes two tools, `apply` and `query`, whose input schema is the API contract.

Claude Code:

```bash
claude mcp add --transport http remora http://localhost:8080/<secret>/mcp
```

Generic JSON client entry:

```json
{"mcpServers":{"remora":{"type":"http","url":"http://localhost:8080/<secret>/mcp"}}}
```

Clients that only speak stdio can bridge with `mcp-remote`.

## Plugins

Plugins add time axes and evidence sources. The core plugin (`remora-core`) is built in. Third-party plugins live in the `plugins` volume (`PLUGINS_DIR=/plugins`). Note that `@remora/sdk` is not published in v1: a plugin is a plain ES module whose default export is an object `{name, configSchema, defaultConfig, setup}` (see `packages/sdk/src/plugin.ts` for the shapes).

Install and enable:

```bash
# 1. install the package into the plugins volume
docker compose exec remora npm install --prefix /plugins <pkg>
# 2. register it (the stored package spec is exactly what you pass)
curl -s -X POST -H 'content-type: application/json' -d '{"package":"<pkg>"}' \
  localhost:8080/$REMORA_ADMIN_SECRET/admin/add_plugin
# 3. plugins are loaded at start
docker compose restart remora
# 4. check the status (ok / degraded / pending_restart, load errors)
curl -s localhost:8080/$REMORA_ADMIN_SECRET/admin/list_plugins
```

Change a plugin's configuration with `POST /<admin>/admin/set_plugin_config {"name":"...","config":{...}}`, then restart. If the plugin's axes or sources already hold data the call is refused with `details.reason: "confirm_required"` until you repeat it with `"confirm": true` (a configuration change may change how existing values are encoded). `remove_plugin {name}` is refused while the plugin owns data. A broken third-party plugin does not stop the service: `/health` reports `degraded` and `list_plugins` shows the error.
