# Postgres Options — Deep Research (11 Options Evaluated)

## Status: RESOLVED (2026-07) — implemented in PR [#20](https://github.com/inflexa-ai/inf-cli/pull/20)

> **Decision (2026-07-01, revised): Docker Compose orchestration — both services on a shared network.**
> Both containers are now managed via a generated Docker Compose file, eliminating the inter-container networking issues that individual `docker run` calls caused. The image is fixed to `pgvector/pgvector:pg18` (not user-overridable); external mode was dropped. The prerequisite recheck still applies: the CLI hard-requires Docker or Podman, so the embedded options evaluated below are unnecessary.
>
> **Authoritative spec:** [`cli/openspec/changes/add-postgres-provisioning/`](../../cli/openspec/changes/add-postgres-provisioning/). The 11-option matrix below is preserved as historical research.

## Status (historical): Research Complete — Decision Made, Implemented

This is the exhaustive evaluation of every known way to ship Postgres alongside a Node.js/Bun CLI. `08-postgres-shipping.md` has the summary recommendation; this doc has the detailed evidence.

## Critical Requirements

1. **pgvector extension** — semantic search for workspace file discovery
2. **Multiple concurrent connections** — DBOS needs separate app pool + system pool + LISTEN/NOTIFY client

## Gap Analysis

No single package satisfies both requirements at production quality:

| | Has pgvector | No pgvector |
|---|---|---|
| **Has concurrent connections** | `@boomship/postgres-vector-embedded` (14 DL/wk, risky) | `embedded-postgres` (189K DL/wk, mature) |
| **No concurrent connections** | PGlite (10M DL/wk, dominant) | pg-mem (emulator, not viable) |

## 1. PGlite (`@electric-sql/pglite`)

Real PostgreSQL 18.3 compiled to WASM, runs entirely in-process. Built by Electric (~$7.3M seed).

| Attribute | Value |
|---|---|
| npm downloads/week | ~10 million |
| GitHub stars | 15,500 |
| Version | 0.5.3 (June 2026) |
| Status | **Alpha** (explicit badge in README) |
| Size | ~3 MB gzipped, ~25.4 MB unpacked |
| Startup | Sub-second |
| Platforms | All (WASM — no native binary needed) |
| pgvector | Yes — `@electric-sql/pglite-pgvector` (~44 KB), HNSW + IVFFlat |
| Persistence | Yes — disk via Node.js filesystem (`new PGlite('./pgdata')`) |

**Why it's ruled out for our use case:**

1. **Single-user mode** — all queries serialize through an async-mutex. Concurrent `db.query()` calls queue and execute one at a time. v0.4 added `pglite-socket` (TCP multiplexer) but docs warn _"not all use cases are guaranteed to work"_ — transaction interleaving and shared session state cause issues.

2. **DBOS incompatible** — DBOS needs: (a) a system database pool (default 10 connections), (b) a dedicated LISTEN/NOTIFY client (long-lived, separate from query connections), (c) concurrent transactions. PGlite provides none of these. Even with `systemDatabasePoolSize: 1`, DBOS still needs the LISTEN/NOTIFY client.

3. **Bun compile broken** — `bun#15032` and `pglite#414` are open issues. PGlite uses WASM that Bun's standalone compiler can't bundle. No fix/ETA.

4. **Multi-process unsafe** — no file locking; WAL corruption documented with concurrent process access.

5. **Performance** — ~2-3x slower than native Postgres for INSERTs, ~10x for unindexed SELECTs, ~30-40x slower than better-sqlite3 for bulk operations.

**But notable for:** 41 extensions available (PostGIS, Apache AGE, pg_trgm), export/import via `dumpDataDir('gzip')`, Apache 2.0 license. If the single-connection limitation is ever resolved, this becomes the clear winner.

## 2. embedded-postgres (leinelissen)

Downloads real PostgreSQL binaries from zonkyio/embedded-postgres-binaries. Spawns a genuine `postgres` server process.

| Attribute | Value |
|---|---|
| npm downloads/week | ~189,000 |
| GitHub stars | 139 |
| Version | Beta (4 years continuous maintenance) |
| Last publish | June 5, 2026 |
| Binary size | macOS ~141 MB, Linux x64 ~56 MB, Windows ~104 MB (compressed ~14-29 MB) |
| Startup | A few seconds |
| PG versions | 14.x through 18.4 (configurable) |
| Platforms | macOS x64+ARM64 (ARM64 needs PG ≥15.8), Linux x64+ARM64+ARM+ia32+ppc64, Windows x64 |
| pgvector | **No** |
| Concurrent connections | Yes (real Postgres server) |

**API:** Clean — `initialise()`, `start()`, `stop()`, `createDatabase()`, `getPgClient()`. Auth: password, md5, scram-sha-256.

**Why pgvector is missing:** The zonkyio binaries are stripped-down "lite" builds without third-party extensions. GitHub issue #19 requests extension support but is unresolved.

**Viable if:** We fork the zonkyio build system and add pgvector to the binary distribution. Most engineering effort but most control.

## 3. @boomship/postgres-vector-embedded

Only package shipping real Postgres + pgvector together.

| Attribute | Value |
|---|---|
| npm downloads/week | **14** |
| GitHub stars | 2 |
| Last publish | August 2025 (11 months ago) |
| PG version | 17.5 |
| pgvector version | 0.8.0 with HNSW |
| Platforms | macOS ARM64+x64, Linux x64+ARM64, Windows x64 (lite only) |
| Concurrent connections | Yes (real Postgres server) |

**Critical risks:** Explicitly _"not a community-driven project"_ — not accepting PRs or feature requests. TypeScript wrapper described as _"illustrative and may not be suitable for production use."_ If the maintainer walks away, you own a fork.

## 4. pg-embedded (PgTsLabs)

PostgreSQL compiled into a native Node addon (`.node` file) via Rust/NAPI-RS.

| Attribute | Value |
|---|---|
| npm downloads/week | ~1,254 |
| GitHub stars | 6 |
| Last publish | September 2025 (9 months ago) |
| PG version | 18.0 |
| Binary size | 12-15 MB (macOS/Linux), 53 MB (Windows) |
| pgvector | Not documented |
| Concurrent connections | Not documented |

Issues disabled on GitHub. Single maintainer. Too risky.

## 5. Docker (`pgvector/pgvector:pg17`)

Programmatic container management via dockerode (~5.1M downloads/week).

| Attribute | Value |
|---|---|
| Image size | ~150 MB compressed, ~370 MB on disk |
| PG versions | 13 through 18 |
| pgvector | Yes (pre-installed, just `CREATE EXTENSION vector`) |
| Startup (cold) | 2-5 seconds |
| Startup (warm) | Sub-second to ~1-2 seconds |
| Concurrent connections | Yes (real Postgres) |
| Persistence | Docker volumes |

**Docker adoption (Stack Overflow 2025):** 71.1% of all respondents use Docker (73.8% professionals). ~26% of professionals lack Docker.

**macOS caveat:** Requires Docker Desktop (paid for commercial use at >250 employees or >$10M revenue), OrbStack ($8/mo), or Colima (free, MIT).

**Detection:** `docker info` with timeout, then fall through to alternatives.

## 6. @testcontainers/postgresql

Part of the Testcontainers ecosystem (~2.4M npm downloads/week). Wraps Docker with nice API.

| Attribute | Value |
|---|---|
| pgvector | Yes — `new PostgreSqlContainer("pgvector/pgvector:pg17")` |
| Startup | 3-10s warm, 30s+ cold |

Designed for ephemeral testing, not persistent data. Runs a Ryuk sidecar container.

## 7. System Postgres

Detect user's existing installation.

| Attribute | Value |
|---|---|
| Postgres usage (SO 2025) | 55.6% of all devs, 58.2% professionals |
| Detection | `pg_isready -q -h localhost -p 5432` (exit code 0 = ready) |
| pgvector (macOS) | `brew install pgvector` |
| pgvector (Debian/Ubuntu) | `postgresql-{VER}-pgvector` from PGDG repo |
| pgvector (Windows) | Compile from source with Visual Studio C++ |

## 8. pg-mem

In-memory Postgres emulation in pure JavaScript.

| Attribute | Value |
|---|---|
| npm downloads/week | ~231,000 |
| pgvector | No |
| Concurrent connections | No |
| Persistence | No (in-memory only) |
| Open issues | 190 |

Not viable — fails both critical requirements.

## 9. Neon Serverless

| Attribute | Value |
|---|---|
| pgvector | Yes (cloud) |
| Local options | Neon Local (Docker proxy, requires internet) |

Not viable for offline-capable CLI.

## 10. Supabase Local

Uses Docker. Spins up **13 containers** (Postgres, Kong, GoTrue, PostgREST, etc.). 7 GB RAM minimum, 2-4 GB image downloads, 3-5 minutes first start.

Not viable — far too heavy.

## 11. Other databases considered

| Option | Verdict |
|---|---|
| CockroachDB | ~200 MB binary, distributed system. Vector indexing in public preview (not GA). Too heavy. |
| YugabyteDB | ~2 GB Docker image, 2 GB min RAM. pgvector Early Access only. |
| Turso/libSQL | SQLite-based, not Postgres. Has native vector search (DiskANN) but not pgvector. Cannot run DBOS. |
| pgmock | In-memory PG mock using x86 emulator. True multi-connection but slower than PGlite. ~1,200 stars. Experimental. |

## Pragmatic Paths Forward

### Path A: Docker-first + system Postgres fallback

Use dockerode to provision `pgvector/pgvector` container. If Docker unavailable, detect system Postgres via `pg_isready` and check for pgvector.

**Pros:** Both critical requirements met on every platform. ~71% of devs have Docker.
**Cons:** ~26% of devs lack Docker; system Postgres detection is best-effort.

### Path B: Fork embedded-postgres + add pgvector

Take the mature `embedded-postgres` ecosystem (189K DL/wk, 4 years) and build pgvector into the binary distribution by forking zonkyio's build system.

**Pros:** Zero Docker dependency, full control, real server with concurrent connections.
**Cons:** Highest engineering effort — maintaining a Postgres binary build pipeline per platform.

### Path C: PGlite for app data + real Postgres for DBOS only

Use PGlite (10M DL/wk, pgvector, instant startup) for application data that doesn't go through DBOS. Require real Postgres (Docker or system) only for DBOS's durable workflow state.

**Pros:** Minimizes the external dependency surface — only DBOS needs real Postgres.
**Cons:** Splits the storage layer (app queries on PGlite, DBOS on Postgres). Two databases to manage.

### Path D: Adapt DBOS to single-connection mode

Write a custom DBOS `SystemDatabase` implementation that eliminates the concurrent pool and LISTEN/NOTIFY requirements, running over PGlite's serialized connection.

**Pros:** Zero external dependencies, sub-second startup, ~25 MB footprint.
**Cons:** Highest risk — DBOS internals are complex. LISTEN/NOTIFY removal affects workflow notification latency.

### Path E: Wait for DBOS TS SQLite support (PR #1288)

If/when PR #1288 merges, DBOS's system database can run on SQLite. Combined with PGlite for pgvector queries, this eliminates the need for real Postgres entirely.

**Pros:** Cleanest long-term architecture.
**Cons:** Depends on external PR timeline. Still need a pgvector solution (PGlite provides this).
