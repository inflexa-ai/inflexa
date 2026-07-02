# Postgres & DBOS Constraint: Storage Interface Design

## Status: RESOLVED — Docker Compose provisioning implemented (PR [#20](https://github.com/inflexa-ai/inf-cli/pull/20))

> The constraint analysis below (why Postgres + pgvector + DBOS are required) remains valid
> reference material. The provisioning decision is settled: Docker Compose with
> `pgvector/pgvector:pg18` alongside CLIProxyAPI. See `cli/openspec/specs/postgres-provisioning/spec.md`.

## 1. The Problem

The CLI uses `bun:sqlite` for all storage. The harness requires:
- **Postgres** (`pg` Pool) — 48 files import it; ~64 queries across the state layer + thread store + workspace search
- **pgvector** — semantic search for file discovery (workspace vector index)
- **DBOS** (`@dbos-inc/dbos-sdk` v4.23.0) — 128+ calls in workflow files; provides durable workflows, step caching, stream persistence, crash recovery

## 2. DBOS SQLite Support — Status by Language

| Language SDK | SQLite support | Status |
|-------------|---------------|--------|
| **Python** (`dbos-transact-py`) | **Yes — default backend** | `sqlite:///path/to/db.sqlite` as system DB; Postgres recommended for prod |
| **Go** (`dbos-transact-golang`) | **Yes — since v0.17 (June 2026)** | `SqliteSystemDB` option via `modernc.org/sqlite` |
| **TypeScript** (`@dbos-inc/dbos-sdk`) | **Not yet — active PR** | [Issue #1226](https://github.com/dbos-inc/dbos-transact-ts/issues/1226) (2026-06-30, open), [PR #1288](https://github.com/dbos-inc/dbos-transact-ts/pull/1288) using `better-sqlite3` (not merged) |

### TypeScript SDK (our case) — Postgres-only today

**Confirmed by:**
- Harness codebase: DBOS configures via `systemDatabaseUrl` (PostgreSQL connection string) at `harness/src/runtime/dbos.ts:68-98`
- OpenSpec `postgres-storage-backend/spec.md:1-5`: _"There is no LibSQL, SQLite, or separate vector database."_
- OpenSpec `cortex-state-layer/spec.md:7-8`: _"there is no SQLite path."_
- DBOS SDK: `@dbos-inc/dbos-sdk` imports `pg` internally — only speaks Postgres

### But SQLite support is coming

**PR #1288** on `dbos-inc/dbos-transact-ts` adds `better-sqlite3` as a system DB adapter. It includes:
- SQL compatibility mapping: `$1/$2` → `?`, `JSONB` → `TEXT`, `ANY()` → `IN`, `FOR UPDATE` removal, boolean mapping
- The DBOS team commented: _"We're definitely considering it in TS. It's trickier in TS because SQLite isn't in the standard library."_

**Key distinction — system DB vs application DB:**
- **System DB** (workflow state, step cache) — requires Postgres today in TS; PR #1288 adds SQLite
- **Application DB** (your domain data) — you bring your own client/ORM; DBOS doesn't constrain it

This means the harness's `cortex_*` application tables could run on SQLite TODAY (they're raw `pg` Pool queries, not DBOS-managed). Only the DBOS system database needs Postgres until PR #1288 lands.

**DBOS requires Postgres for:** workflow state (`dbos.workflow_status`), step cache (`dbos.operation_outputs`), durable streams, send/recv queues, recovery bookkeeping.

## 3. Postgres-Specific SQL in the Harness State Layer

| Feature | Usage count | SQLite equivalent |
|---------|-------------|-------------------|
| `$1`, `$2` parameterized queries | ~64 queries | `?` positional params |
| `JSONB` columns + `::jsonb` casts | ~20 columns | `JSON` (text-based, no indexing) |
| `ON CONFLICT ... DO UPDATE` (upsert) | ~8 queries | Supported (SQLite ≥ 3.24) |
| `ANY($1::text[])` array operations | ~4 queries | `IN (...)` with expansion |
| `TIMESTAMPTZ` + `NOW()` | ~15 columns | `TEXT` + `datetime('now')` |
| `COALESCE` | ~8 queries | Supported |
| `RETURNING` | — | Supported (SQLite ≥ 3.35) |
| `pgvector` (`vector` type + `<=>`) | ~4 queries | No equivalent |
| Advisory locks (`pg_advisory_lock`) | 1 call (init) | No equivalent (file locks) |

**Key insight:** Most of the SQL is translatable (param style, timestamps, upserts). The blockers are **pgvector** (no SQLite equivalent) and **DBOS** (Postgres-only engine).

## 4. Two-Pool Architecture

The harness runs two separate Postgres pools against the same cluster (`harness/src/runtime/pools.ts`):

1. **Application Pool** (`src/lib/storage.ts:createPool()`) — cortex_* state tables, pgvector search
2. **DBOS System Pool** (`src/runtime/dbos.ts`) — workflow state, step cache, streams

Boot-time guard `assertConnectionBudget` verifies both fit within Postgres `max_connections`.

## 5. Storage Interface Approach

### What a storage interface would look like

Instead of the harness importing `Pool` from `pg` directly, it would use an injected interface:

```typescript
interface HarnessStore {
    // ── Runs ──
    insertRun(params: InsertRunParams): Promise<void>;
    updateRunStatus(runId: string, status: RunStatus, error?: string): Promise<void>;
    queryRun(runId: string): Promise<CortexRunRow | null>;
    queryActiveRun(analysisId: string): Promise<CortexRunRow | null>;

    // ── Step executions ──
    insertStepExecution(params: InsertStepParams): Promise<void>;
    updateStepExecution(stepId: string, runId: string, patch: StepPatch): Promise<void>;

    // ── Artifacts ──
    upsertArtifacts(entries: ArtifactEntry[]): Promise<void>;
    queryArtifactsForRun(analysisId: string, runId: string): Promise<ArtifactRow[]>;
    countArtifactsForRun(analysisId: string, runId: string): Promise<number>;

    // ── Analysis state ──
    upsertAnalysis(params: UpsertAnalysisParams): Promise<void>;
    tryStartDataProfile(analysisId: string): Promise<boolean>;
    completeDataProfile(analysisId: string, result?: DataProfileResult): Promise<void>;

    // ── Messages (thread store) ──
    appendMessage(threadId: string, message: MessageRow): Promise<void>;
    loadThread(threadId: string, limit?: number): Promise<MessageRow[]>;

    // ── Working memory ──
    loadWorkingMemory(analysisId: string): Promise<WorkingMemory | null>;
    saveWorkingMemory(analysisId: string, data: WorkingMemory): Promise<void>;

    // ── Vector search (optional — may be no-op for CLI) ──
    vectorSearch?(query: string, indexName: string, limit: number): Promise<SearchResult[]>;
    vectorUpsert?(indexName: string, entries: VectorEntry[]): Promise<void>;
}
```

### Effort estimate

| Task | Files affected | Effort |
|------|---------------|--------|
| Define `HarnessStore` interface | 1 new file | 1hr |
| Create Postgres implementation | 1 new file (wraps existing `state/*.ts`) | 2hr |
| Create SQLite implementation | 1 new file | 4-6hr |
| Replace `Pool` with `HarnessStore` in all consumers | ~48 files | 4-6hr |
| Replace raw SQL queries in state layer with store calls | ~12 state files, ~64 queries | 6-8hr |
| Handle pgvector (no-op for SQLite, or alternative) | 1 file | 2hr |
| Handle DBOS (see below) | Complex | see below |
| **Subtotal (excluding DBOS)** | | **~20-25hr** |

### The DBOS problem

DBOS is deeply embedded: 128+ `DBOS.runStep`, `DBOS.startWorkflow`, `DBOS.cancelWorkflow`, `DBOS.writeStream`, `DBOS.recv` calls across workflow files. DBOS provides:

1. **Step caching** — `DBOS.runStep(fn, {name})` caches results so crash recovery replays from cache
2. **Workflow durability** — registered workflows survive process restarts
3. **Durable streams** — `DBOS.writeStream` / `DBOS.readStream` for run events
4. **Send/recv** — `DBOS.send`/`DBOS.recv` for cross-workflow communication
5. **Workflow lifecycle** — `DBOS.cancelWorkflow`, `DBOS.resumeWorkflow`

**None of these have SQLite equivalents.** Replacing DBOS is a separate, much larger effort.

## 6. Revised Approach: Hybrid Architecture

Given DBOS's Postgres requirement, the realistic path is:

### Option A: CLI provisions a lightweight Postgres (e.g., embedded-postgres)

Use a npm package like `embedded-postgres` to provision a local Postgres instance automatically. The CLI starts it on first use, stores data in `~/.inflexa/postgres/`.

**Pros:**
- Full harness compatibility — no code changes to the harness or DBOS
- pgvector and DBOS work as-is
- Automatic lifecycle management (start/stop with CLI)

**Cons:**
- ~100MB disk for the Postgres binary
- ~2-3 second startup overhead
- Platform-specific binaries (amd64/arm64, Linux/macOS)
- More complex than SQLite for a "local-first" tool

### Option B: Bypass DBOS for CLI execution (refined from prior doc)

Run the harness's agent loop directly with `passthroughStep` (no DBOS). The harness already has this path for chat turns. The CLI provides a thin SQLite-based store for the subset of state the agent needs.

**What this means:**
- No crash recovery (acceptable for a local CLI)
- No parallel step execution (steps run sequentially)
- No durable streams (CLI shows progress directly)
- The CLI imports harness primitives and composes its own execution loop

**Effort:** ~10-15hr to build the CLi-side execution layer that replaces the DBOS orchestration.

### Option C: Storage interface + embedded Postgres for DBOS

**Hybrid approach:**
1. Build the `HarnessStore` interface for application tables (~20-25hr)
2. CLI wires a SQLite `HarnessStore` for app tables
3. DBOS runs on an embedded Postgres (for workflow durability only)
4. pgvector either runs on the embedded Postgres, or is replaced with a simpler search

This gives CLI-friendly storage (SQLite for its own data) while keeping DBOS's durability guarantees.

### Option D: Start with embedded Postgres, abstract later

The fastest path to working integration:
1. CLI provisions embedded Postgres on first run
2. Harness runs unmodified — all queries, DBOS, pgvector work
3. Storage interface is a future optimization if the Postgres dep becomes burdensome

**Effort:** ~5hr (embedded-postgres setup + CLI lifecycle management)

## 7. Recommendation

> **Update (2026-07-01): SUPERSEDED.** The "Option D — embedded Postgres" recommendation below is no longer the plan. A prerequisite recheck found the CLI already hard-requires Docker or Podman (`cli/src/modules/proxy/setup.ts:46`), which collapses the option space: provisioning `pgvector/pgvector:pg18` as an `--restart unless-stopped` container (alongside the existing `inflexa-cliproxy` proxy container) gives full pgvector + multi-connection + DBOS support with zero new npm deps, beats every embedded-binary option on supply-chain risk and maintenance, and matches the harness's own testcontainer convention. Authoritative spec: [`cli/openspec/changes/add-postgres-provisioning/`](../../cli/openspec/changes/add-postgres-provisioning/). The constraint analysis in this doc (why Postgres + pgvector + DBOS are required) remains authoritative; only the "embedded binary" recommendation is overridden.

**Start with Option D (embedded Postgres)**, then evaluate whether the storage interface is worth the 20-25hr investment based on real-world feedback.

**Rationale:**
- Unblocks the integration immediately (~5hr vs ~25hr+)
- The harness is actively developed — a storage interface that wraps 64 queries will need maintenance as new queries are added
- Embedded Postgres is battle-tested (used by Supabase CLI, PostgREST, many dev tools)
- If users push back on the Postgres dep, the storage interface can be built incrementally (one table at a time)
- DBOS can't be replaced by a storage interface anyway — it's a whole execution engine, not just a database

## 8. Embedded Postgres Options

| Package | Stars | Platforms | Notes |
|---------|-------|-----------|-------|
| `embedded-postgres` (npm) | ~200 | Linux, macOS (amd64/arm64) | Managed lifecycle, data dir config |
| `@embedded-postgres/linux-arm64` etc. | — | Per-platform binaries | Low-level, compose yourself |
| `pg-mem` | ~2K | In-memory only | Not suitable (no persistence) |

The `embedded-postgres` approach would:
1. On `inflexa` first run: download + extract Postgres binary (~100MB)
2. Store data in `~/.inflexa/data/postgres/`
3. Start Postgres on a random port before harness init
4. Stop Postgres on CLI exit
5. The harness connects to `localhost:{port}` with no code changes
