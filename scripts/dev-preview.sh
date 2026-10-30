#!/usr/bin/env bash
# Runs the API and web dev servers on free ports against a throwaway, seeded database, so a change can
# be checked in a (headless) browser while other checkouts run their own preview, tests or `pnpm dev`.
# Prints the URL and the demo login when it's ready; Ctrl-C, or the end of --ttl, stops both servers
# and drops the database.
#
#   pnpm dev:preview              # stops by itself after an hour
#   pnpm dev:preview --ttl 20m    # s, m or h
set -euo pipefail
cd "$(dirname "$0")/.."

ttl=1h
while [ $# -gt 0 ]; do
  case "$1" in
    --ttl)
      ttl="${2:?--ttl needs a duration, e.g. 30m}"
      shift 2
      ;;
    -h | --help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done
case "$ttl" in
  *h) ttl_s=$((${ttl%h} * 3600)) ;;
  *m) ttl_s=$((${ttl%m} * 60)) ;;
  *s) ttl_s=${ttl%s} ;;
  *) ttl_s=$ttl ;;
esac

[ -d node_modules ] || {
  echo "No node_modules: run pnpm install first." >&2
  exit 1
}

# Its own database, so the preview's migrations and job workers don't touch the dev database or another
# preview's. Named after this process, so leftovers of killed previews can be found and dropped.
base="${DATABASE_URL:-postgres://ordo:ordo@localhost:5433/ordo}"
name="ordo_preview_$$"
url="${base%/*}/$name"
db() { (cd apps/api && node --input-type=module -e "
  import postgres from 'postgres';
  const sql = postgres(process.argv[1], { max: 1, onnotice: () => {}, connect_timeout: 5 });
  await sql.unsafe(process.argv[2]);
  await sql.end();" "$base" "$1"); }
drop_stale() { (cd apps/api && node --input-type=module -e "
  import postgres from 'postgres';
  const sql = postgres(process.argv[1], { max: 1, onnotice: () => {} });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  for (const { datname } of await sql\`select datname from pg_database where datname like 'ordo_preview_%'\`) {
    const pid = Number(datname.slice('ordo_preview_'.length));
    if (!alive(pid)) await sql.unsafe(\`drop database if exists \${datname} with (force)\`);
  }
  await sql.end();" "$base"); }
free_port() { node -e "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => {
  console.log(s.address().port); s.close(); });"; }

db 'select 1' >/dev/null 2>&1 || {
  echo "Can't reach Postgres at ${base%/*}: start it with make dev-db." >&2
  exit 1
}

logs="$(mktemp -d "${TMPDIR:-/tmp}/ordo-preview.XXXXXX")"
api_pid=
web_pid=
cleanup() {
  trap - EXIT INT TERM
  # Each server runs in its own process group (set -m below), so this stops pnpm, tsx and vite alike.
  for pid in $web_pid $api_pid; do kill -- "-$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  db "drop database if exists $name with (force)" 2>/dev/null || true
  echo "Preview stopped; logs in $logs"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

drop_stale
db "create database $name"
echo "Seeding $name…"
DATABASE_URL="$url" pnpm --silent db:seed >"$logs/seed.log" 2>&1 || {
  cat "$logs/seed.log" >&2
  exit 1
}

api_port=$(free_port)
web_port=$(free_port)
while [ "$web_port" = "$api_port" ]; do web_port=$(free_port); done
public="http://localhost:$web_port"

set -m
(
  cd apps/api
  DATABASE_URL="$url" HOST=127.0.0.1 PORT=$api_port ORDO_PUBLIC_URL="$public" exec pnpm --silent dev
) >"$logs/api.log" 2>&1 &
api_pid=$!
(
  cd apps/web
  ORDO_API_URL="http://127.0.0.1:$api_port" exec pnpm --silent dev --port "$web_port" --strictPort
) >"$logs/web.log" 2>&1 &
web_pid=$!
set +m

ready=
for _ in $(seq 1 120); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$api_port/api/health" 2>/dev/null &&
    curl -fsS -o /dev/null "$public/" 2>/dev/null; then
    ready=1
    break
  fi
  kill -0 "$api_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null || break
  sleep 0.5
done
if [ -z "$ready" ]; then
  echo "Preview failed to start." >&2
  tail -n 30 "$logs/api.log" "$logs/web.log" >&2
  exit 1
fi

cat <<EOF
Ordo preview ready: $public
Sign in as demo@ordo.test / ordo-demo-password (workspace "demo")
Logs: $logs/api.log, $logs/web.log; stops in $ttl or on Ctrl-C
EOF

end=$((SECONDS + ttl_s))
while [ $SECONDS -lt $end ] && kill -0 "$api_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null; do
  sleep 2
done
if [ $SECONDS -lt $end ]; then
  echo "A dev server exited:" >&2
  tail -n 30 "$logs/api.log" "$logs/web.log" >&2
  exit 1
fi
