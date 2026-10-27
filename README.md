# remora

Memory service for LLM agents: facts, events and evidence over PostgreSQL, served through a secret-URL HTTP API and MCP.

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
