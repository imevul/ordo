#!/usr/bin/env bash
# Builds the production bundles, copies them somewhere without node_modules, boots the API
# and waits for /api/health. Catches dependencies esbuild can't bundle before they ship.
set -euo pipefail
cd "$(dirname "$0")/.."

# A throwaway database next to the dev one: the server runs migrations and job workers, which must
# not touch (or steal jobs from) a real database.
base="${DATABASE_URL:-postgres://ordo:ordo@localhost:5433/ordo}"
check_db="ordo_bundle_check_$$"
db() { (cd apps/api && node --input-type=module -e "
  import postgres from 'postgres';
  const sql = postgres(process.argv[1], { max: 1, onnotice: () => {} });
  await sql.unsafe(process.argv[2]);
  await sql.end();" "$base" "$1"); }

pnpm build >/dev/null
dir=$(mktemp -d)
cleanup() {
  if [ -n "${pid:-}" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  db "drop database if exists $check_db with (force)" || true
  rm -rf "$dir"
}
trap cleanup EXIT
db "create database $check_db"
cp apps/api/dist/*.mjs apps/api/package.json "$dir/"
cp -r apps/api/drizzle "$dir/drizzle"
cp -r apps/web/dist "$dir/public"

port=$((20000 + RANDOM % 20000))
(
  cd "$dir"
  NODE_ENV=production PORT=$port HOST=127.0.0.1 \
    DATABASE_URL="${base%/*}/$check_db" \
    ORDO_SECRET_KEY="$(head -c 32 /dev/urandom | base64)" \
    ORDO_STATIC_DIR="$dir/public" ORDO_MIGRATIONS_DIR="$dir/drizzle" \
    exec node server.mjs >"$dir/server.log" 2>&1
) &
pid=$!

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    curl -fsS -o /dev/null "http://127.0.0.1:$port/" && echo "Bundle OK: API and web served without node_modules."
    exit 0
  fi
  sleep 0.2
done
echo "Bundle failed to start:" >&2
cat "$dir/server.log" >&2
exit 1
