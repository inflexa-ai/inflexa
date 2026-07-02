# Shipping Postgres with the CLI

## Status: RESOLVED (2026-07) — implemented in PR [#20](https://github.com/inflexa-ai/inf-cli/pull/20)

> **Decision (2026-07-01, revised): Docker Compose orchestration alongside the proxy.**
> This doc evaluated shipping an embedded Postgres binary with Docker as a fallback. The CLI already hard-requires Docker or Podman, so a second container costs nothing. Both services (CLIProxyAPI + Postgres) are now managed via a single generated Docker Compose file on a shared `inflexa` network — solving inter-container networking and giving a single lifecycle (`compose up/down`). The image is fixed to `pgvector/pgvector:pg18` (not user-overridable); external mode was removed. `inflexa setup` now prompts for username/password/port via `@clack/prompts`.
>
> **Authoritative spec:** [`cli/openspec/changes/add-postgres-provisioning/`](../../cli/openspec/changes/add-postgres-provisioning/) — proposal, design, `specs/postgres-provisioning/spec.md`, tasks. The body of this doc is preserved as historical research.

## Status (historical): Research Complete — Decision Made, Implemented

## 1. Context

The CLI compiles to a **single Bun standalone binary** via `Bun.build({ compile: true })` (`cli/scripts/build.ts:137-152`) for 4 platforms: darwin-arm64, darwin-x64, linux-x64, windows-x64.

The harness needs Postgres with:
- **pgvector extension** — semantic search for file discovery
- **Multiple concurrent connections** — DBOS requires separate app + system pools
- **Disk persistence** — analysis state survives CLI restarts

## 2. Decision Table

| | **PGlite** | **embedded-postgres** | **@boomship/postgres-vector-embedded** | **Docker** | **System Postgres** |
|---|---|---|---|---|---|
| **Package** | `@electric-sql/pglite` | `embedded-postgres` (leinelissen) | `@boomship/postgres-vector-embedded` | `pgvector/pgvector:pg17` | User-installed |
| **What it is** | Postgres compiled to WASM, runs in-process | Downloads real Postgres binary per platform | Downloads real Postgres + pgvector binaries | Container with Postgres + pgvector | User manages everything |
| **Feasibility** | 1/5 | 3/5 | **4/5** | 4/5 | 3/5 |
| **Size** | ~3.7 MB | ~60-150 MB per platform | ~60-150 MB per platform | ~156 MB pull + ~430 MB disk | 0 (user-provided) |
| **Startup** | ~250 ms | 1-3 s | 1-3 s | 5-10 s | Already running |
| **pgvector** | Yes (WASM ext) | No (must compile manually) | **Yes (bundled)** | **Yes (built-in)** | Manual install |
| **Multi-connection** | **No** (single-user mode) | Yes (real Postgres) | Yes (real Postgres) | Yes (real Postgres) | Yes |
| **Platforms** | All (WASM) | darwin-arm64/x64, linux-x64, windows-x64 | darwin-arm64/x64, linux-x64/arm64. **No Windows** | All (needs Docker) | All (needs manual install) |
| **Bun compile** | **Blocked** (bun#15032, pglite#414) | Works (external binaries) | Works (external binaries) | N/A (separate process) | N/A |
| **Main blocker** | Bun compile broken + single-conn kills DBOS | pgvector not bundled | No Windows support | Requires Docker Desktop | Worst UX |

## 3. Analysis

### PGlite — Ruled out

Two dealbreakers:
1. **Bun standalone compile is broken** — `bun#15032` and `pglite#414` are open issues with no fix/ETA. PGlite uses WASM that the Bun compiler can't bundle.
2. **Single-connection mode** — DBOS needs concurrent connections (separate app pool + system pool). PGlite v0.4's multiplexer is partial and not production-ready.

### embedded-postgres (leinelissen) — Viable but incomplete

Downloads a real Postgres binary at first run. Supports all 4 CLI target platforms. But:
- **No pgvector** — the bundled Postgres doesn't include pgvector. You'd need to compile the extension separately per platform, which is a significant build/distribution burden.
- Good for dev/testing, not ideal for production distribution.

### @boomship/postgres-vector-embedded — Recommended primary

Downloads real Postgres **with pgvector already bundled**. The only option that gives both real Postgres (multi-connection, full SQL) AND pgvector out of the box.

- **Main risk: No Windows** — supports darwin-arm64, darwin-x64, linux-x64, linux-arm64 but not windows-x64.
- Newer/smaller community than `embedded-postgres`.
- Binaries are external to the CLI binary (downloaded on first use or pre-staged).

### Docker — Recommended fallback

The `pgvector/pgvector:pg17` image provides everything: real Postgres, pgvector, full concurrent connection support.

- **Requires Docker** — Docker Desktop on macOS (paid for >250 employees), Docker Engine on Linux.
- Heavier startup (~5-10s for container creation).
- Best UX on CI/server environments; worst on dev laptops without Docker.

### System Postgres — Last resort

Detect user's Postgres, ask them to install pgvector manually. Only viable when users are developers who already run Postgres.

## 4. Recommended Strategy: Tiered Fallback

```
1. Detect: Is @boomship/postgres-vector-embedded available?
   ├─ Yes → Start embedded Postgres + pgvector (preferred)
   │        Data at ~/.inflexa/data/postgres/
   │        Random port, connection string passed to harness
   │
   └─ No (Windows, or binary download failed)
       ├─ Detect: Is Docker available? (`docker info`)
       │   ├─ Yes → Start pgvector/pgvector:pg17 container
       │   │        Volume mount at ~/.inflexa/data/postgres/
       │   │        Port-mapped, connection string passed to harness
       │   │
       │   └─ No → Detect: Is a system Postgres reachable?
       │       ├─ Yes → Check for pgvector extension
       │       │   ├─ Installed → Use system Postgres
       │       │   └─ Missing → Prompt user to install pgvector
       │       │
       │       └─ No → Error: "inflexa requires PostgreSQL. Install Docker or Postgres."
```

### CLI lifecycle management

```typescript
// Proposed: cli/src/harness/postgres.ts

interface PostgresHandle {
    connectionString: string;
    stop(): Promise<void>;
}

async function provisionPostgres(): Promise<PostgresHandle> {
    // 1. Try embedded postgres-vector
    // 2. Try Docker
    // 3. Try system Postgres
    // 4. Error with install instructions
}
```

- **First run:** Download embedded Postgres binary (~60-150MB, one-time)
- **Subsequent runs:** Start from cached binary (~1-3s startup)
- **Data directory:** `~/.inflexa/data/postgres/` (persists across CLI runs)
- **Shutdown:** `handle.stop()` called from CLI's shutdown hook (`src/lib/shutdown.ts`)
- **Port:** Random available port to avoid conflicts

## 5. Windows Gap

`@boomship/postgres-vector-embedded` doesn't support Windows. Options:

1. **Docker fallback** — Windows users need Docker Desktop (or WSL2 + Docker Engine)
2. **WSL2 detection** — CLI could detect WSL2 and run the Linux embedded Postgres inside it
3. **Defer** — Windows is the lowest-priority platform (build.ts target matrix lists it but the build isn't smoke-tested — `scripts/build.ts:127` comments that Windows highlighting is "unverified")

**Recommendation:** Docker fallback on Windows. Document it as a prerequisite.

## 6. Distribution Implications

### Binary size

The embedded Postgres binaries are NOT embedded in the CLI binary — they're downloaded on first use (like tree-sitter grammars). The CLI binary stays small (~50-80MB); the Postgres runtime is a separate download cached at `~/.inflexa/data/postgres-runtime/`.

### Offline support

First run requires internet to download the Postgres binary. Subsequent runs work offline (cached binary + local data directory).

### Alternative: Vendor Postgres in the distribution

Instead of downloading at runtime, ship a platform-specific archive alongside each CLI binary:
```
inflexa-darwin-arm64          (CLI binary)
inflexa-darwin-arm64.pg.tar   (Postgres + pgvector runtime)
```

User extracts both. CLI detects the sibling archive and uses it. This avoids the first-run download but doubles the distribution size.

## 7. Effort Estimate

| Task | Effort |
|------|--------|
| `provisionPostgres()` with @boomship fallback to Docker | 4hr |
| CLI lifecycle (start on analyze, stop on exit) | 2hr |
| Data directory management (~/.inflexa/data/postgres/) | 1hr |
| First-run download + progress indicator | 2hr |
| Windows Docker fallback path | 2hr |
| Integration with harness composition root | 2hr |
| Testing (darwin + linux, manual Docker test) | 3hr |
| **Total** | **~16hr** |
