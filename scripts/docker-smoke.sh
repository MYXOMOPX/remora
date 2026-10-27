#!/usr/bin/env bash
# Docker smoke run: builds the image, starts compose with throwaway secrets,
# exercises HTTP, MCP, the plugin install flow and graceful SIGTERM shutdown,
# then removes every container, network, volume and (unless KEEP_IMAGE=1) the image.
# Not part of `npm test`. Usage: scripts/docker-smoke.sh   (PORT=18080 by default)
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT=remora-smoke
PORT="${SMOKE_PORT:-18080}"
BASE="http://127.0.0.1:$PORT"
ENV_FILE="$(mktemp)"
export COMPOSE_PROJECT_NAME="$PROJECT"
dc() { docker compose --env-file "$ENV_FILE" "$@"; }
gen() { node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"; }

SECRET="$(gen)"
ADMIN="$(gen)"
DBPASS="$(gen)"
printf 'REMORA_SECRET=%s\nREMORA_ADMIN_SECRET=%s\nPOSTGRES_PASSWORD=%s\nREMORA_PORT=%s\n' "$SECRET" "$ADMIN" "$DBPASS" "$PORT" > "$ENV_FILE"

cleanup() {
  code=$?
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  if [ -z "${KEEP_IMAGE:-}" ]; then docker rmi -f "${PROJECT}-remora" >/dev/null 2>&1 || true; fi
  rm -f "$ENV_FILE"
  [ $code -eq 0 ] && echo "SMOKE OK" || echo "SMOKE FAILED ($code)"
  exit $code
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
expect() { # expect <label> <haystack> <needle>
  case "$2" in *"$3"*) echo "ok   $1";; *) fail "$1: expected '$3' in: $2";; esac
}
post() { curl -s -X POST -H 'content-type: application/json' -d "$2" "$BASE/$1"; }

echo "== compose refuses to start without POSTGRES_PASSWORD"
NOPASS="$(mktemp)"
printf 'REMORA_SECRET=%s\n' "$SECRET" > "$NOPASS"
if OUT="$(docker compose --env-file "$NOPASS" config 2>&1)"; then fail "compose accepted a missing POSTGRES_PASSWORD"; fi
rm -f "$NOPASS"
expect needs-password "$OUT" "set POSTGRES_PASSWORD in .env"

echo "== build + up"
dc up -d --build --wait
expect health "$(curl -s "$BASE/health")" '"status":"ok"'

echo "== port is published on loopback only"
expect loopback-only "$(docker port "$(dc ps -q remora)" 8080/tcp)" "127.0.0.1:$PORT"
expect host-in-container "$(dc exec -T remora printenv HOST | tr -d '\r')" "0.0.0.0"

echo "== image contains no tests, sources or tsconfigs"
LEFT="$(docker run --rm --entrypoint sh "${PROJECT}-remora" -c 'find /app -path /app/node_modules -prune -o \( -name "*.test.*" -o \( -name "*.ts" ! -name "*.d.ts" \) -o -name "tsconfig*" -o -name test -o -name fixtures \) -print' | tr -d '\r')"
[ -z "$LEFT" ] || fail "unexpected files in the image: $LEFT"
echo "ok   image has dist + migrations only"

echo "== non-root"
UID_IN="$(dc exec -T remora id -u | tr -d '\r')"
[ "$UID_IN" != "0" ] || fail "container runs as root"
echo "ok   uid=$UID_IN"

echo "== apply + query via secret URL"
expect apply "$(post "$SECRET/apply" '{"ops":[{"op":"create_entity","key":"bob"}]}')" '"ok":true'
expect query "$(post "$SECRET/query" '{"ops":[{"op":"get_entity","key":"bob"}]}')" '"ok":true'
expect wrong-secret-404 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/${SECRET}x/schema")" 404

echo "== MCP tools/list"
MCP="$(curl -s -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$BASE/$SECRET/mcp")"
expect mcp-apply "$MCP" '"name":"apply"'
expect mcp-query "$MCP" '"name":"query"'

echo "== admin + plugin install flow"
expect list-core "$(curl -s "$BASE/$ADMIN/admin/list_plugins")" remora-core
dc exec -T remora sh -c '
  set -e
  d=$(mktemp -d) && cd "$d"
  cat > package.json <<JSON
{"name":"remora-plugin-smoke","version":"1.0.0","type":"module","main":"index.js"}
JSON
  cat > index.js <<JS
export default {
  name: "smoke",
  configSchema: { type: "object" },
  defaultConfig: {},
  setup: () => ({ timeAxes: [{ name: "smoke_axis", description: "Smoke axis.", valueSchema: { type: "integer" }, example: 1, encode: (v) => BigInt(v), decode: (n) => Number(n) }] }),
};
JS
  npm pack --silent >/dev/null
  npm install --prefix /plugins --no-audit --no-fund "$d"/remora-plugin-smoke-1.0.0.tgz
' >/dev/null
expect add-plugin "$(post "$ADMIN/admin/add_plugin" '{"package":"remora-plugin-smoke"}')" '"restart_required":true'
expect pending "$(curl -s "$BASE/$ADMIN/admin/list_plugins")" pending_restart
dc restart remora >/dev/null
for i in $(seq 1 30); do
  [ "$(curl -s "$BASE/health" || true)" = '{"status":"ok"}' ] && break
  sleep 1
done
LIST="$(curl -s "$BASE/$ADMIN/admin/list_plugins")"
expect plugin-axis "$LIST" smoke_axis
expect data-survived-restart "$(post "$SECRET/query" '{"ops":[{"op":"get_entity","key":"bob"}]}')" '"ok":true'

echo "== image size"
echo "image: $(docker image inspect -f '{{.Size}}' "${PROJECT}-remora" | awk '{printf "%.0f MB", $1/1000000}')"

echo "== graceful SIGTERM with a request in flight (docker stop)"
CID="$(dc ps -q remora)"
OUT="$(mktemp)"
# chunked body trickled over ~4s: the request is in flight when SIGTERM arrives
( printf '{"ops":[{"op":"create_entity",'; sleep 4; printf '"key":"inflight"}]}' ) |
  curl -s -X POST -H 'content-type: application/json' -H 'transfer-encoding: chunked' -T -     -w '
HTTP %{http_code}' "$BASE/$SECRET/apply" > "$OUT" &
CURL_PID=$!
sleep 1
START=$(date +%s)
docker stop -t 30 "$CID" >/dev/null
EXIT="$(docker inspect -f '{{.State.ExitCode}}' "$CID")"
wait $CURL_PID || true
echo "stopped in $(( $(date +%s) - START ))s, exit code $EXIT, in-flight response: $(tr '
' ' ' < "$OUT")"
BODY="$(cat "$OUT")"; rm -f "$OUT"
[ "$EXIT" = "0" ] || fail "expected exit code 0, got $EXIT"
expect inflight-completed "$BODY" '"ok":true'
expect inflight-status "$BODY" 'HTTP 200'
expect shutdown-logged "$(docker logs "$CID" 2>&1)" '"msg":"shutting down"'
