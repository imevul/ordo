#!/usr/bin/env bash
# Fails when a workspace package.json isn't copied into the Dockerfile's dependency layer. A missing
# one still builds, but pnpm then reinstalls inside `RUN pnpm build`, outside the store cache, so
# the image needs the registry on every build.
set -euo pipefail
cd "$(dirname "$0")/.."

missing=0
for pkg in apps/*/package.json packages/*/package.json; do
  dir="${pkg%/package.json}"
  if ! grep -qxF "COPY $pkg $dir/" Dockerfile; then
    echo "Dockerfile: missing 'COPY $pkg $dir/' before pnpm install" >&2
    missing=1
  fi
done
[ "$missing" = 0 ] && echo "Dockerfile copies every workspace package.json."
exit "$missing"
