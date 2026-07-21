#!/usr/bin/env bash
#
# Run the FULL harness test suite (unit + DB + DBOS) against ONE pgvector
# Postgres. Bun isolates module state per test file, so a module-level
# singleton in src/__tests__/setup/postgres.ts is NOT shared across the DB
# files — started from inside the process, each would spin its own container.
# This script starts ONE container, exports `CORTEX_TEST_PG_URL` (a real
# OS-process env var, inherited by every file), runs `bun test`, and removes
# the container on exit (pass, fail, or interrupt). CI does the same thing
# with a `services:` container (see .github/workflows/test.yml).
#
# Point at an already-running Postgres instead by setting CORTEX_TEST_PG_URL
# before invoking — the script then skips container startup:
#
#   CORTEX_TEST_PG_URL=postgres://cortex:dev@localhost:5433/cortex bun run test:full
#
# Extra args pass through to `bun test`, e.g. `bun run test:full src/state`.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -n "${CORTEX_TEST_PG_URL:-}" ]; then
    echo "Using existing CORTEX_TEST_PG_URL — skipping container startup."
    exec bun test "$@"
fi

CID=$(docker run -d --rm \
    -e POSTGRES_USER=cortex -e POSTGRES_PASSWORD=cortex -e POSTGRES_DB=cortex \
    -p 127.0.0.1::5432 \
    pgvector/pgvector:pg18 \
    postgres -c fsync=off -c synchronous_commit=off)
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 60); do
    docker exec "$CID" pg_isready -U cortex -d cortex >/dev/null 2>&1 && break
    sleep 0.5
done

PORT=$(docker port "$CID" 5432/tcp | head -1 | cut -d: -f2)
export CORTEX_TEST_PG_URL="postgres://cortex:cortex@127.0.0.1:${PORT}/cortex"
echo "Postgres ready on 127.0.0.1:${PORT} (CORTEX_TEST_PG_URL set)."

bun test "$@"
