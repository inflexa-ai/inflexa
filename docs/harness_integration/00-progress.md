# Harness Integration — Progress Tracker

## Iteration 16 (2026-07-01) — Postgres provisioning DONE (PR #20)

**What changed:** PR [inflexa-ai/inf-cli#20](https://github.com/inflexa-ai/inf-cli/pull/20) implements the Docker Compose provisioning approach from iteration 15. Postgres is no longer a blocker for harness integration.

**What PR #20 delivers:**
1. **`modules/proxy/` → `modules/infra/`** — renamed to reflect multi-service scope
2. **Docker Compose orchestration** — generated `docker-compose.yml` managing CLIProxyAPI + `pgvector/pgvector:pg18` on a shared `inflexa` network
3. **`inflexa up` / `inflexa down --delete-data`** — lifecycle commands for the infra stack
4. **Interactive setup** — `@clack/prompts` for provider select, Postgres credentials (user/pass/port) with defaults, progress spinners, auth URL clipboard copy
5. **Environment-aware naming** — `inflexa-dev-*` vs `inflexa-*` container names
6. **PG 18 fixes** — correct mount path (`/var/lib/postgresql`), pgvector retry on init-phase race, standalone container migration before compose up
7. **Settings TUI** — Postgres fields (host/port/db/user/password)
8. **Spec archived** — `openspec/specs/postgres-provisioning/` synced and change archived

**Docs impact:**
- `07-postgres-dbos-constraint.md` — RESOLVED (constraint analysis stays as reference)
- `08-postgres-shipping.md` — RESOLVED (historical research only)
- `09-postgres-options-deep-research.md` — RESOLVED (historical research only)
- `05-implementation-checklist.md` — Phase 3 status banner updated; Postgres is no longer a blocker

**What remains for harness integration:** Phases 1–5 of the implementation checklist (provenance stash, BusProvenanceAdapter, composition root wiring, run lifecycle events, test + cleanup). All are unblocked.

---

## Iteration 15 (2026-07-01) — Docker Compose orchestration, drop external mode

**What changed:** Revised the Postgres provisioning approach based on user testing feedback:

1. **Docker Compose** — both CLIProxyAPI and Postgres are now managed via a generated `docker-compose.yml` on a shared `inflexa` network. Fixes the inter-container networking bug (proxy couldn't reach Postgres via `localhost` because each container has its own loopback).
2. **Module rename `modules/proxy/` → `modules/infra/`** — the setup orchestrator manages multiple services; `proxy` was misleading.
3. **Interactive prompts** — `inflexa setup` now prompts for Postgres username, password, and port via `@clack/prompts`. Non-interactive terminals use defaults.
4. **Dropped external mode** — no `postgres.mode` config key; always provisions its own container. Eliminates TCP probe, psql-on-PATH code paths, and the mode radio in the settings TUI.
5. **Dropped image override** — `postgres.image` removed from config; always `pgvector/pgvector:pg18`. Power users edit the compose file directly.
6. **Progress feedback** — every provisioning step now surfaces clear messages so the user isn't waiting in silence.

**Scope boundary:** unchanged — lands the substrate, does not wire the harness.

---

## Iteration 14 (2026-07-01) — Decision: Docker-first Postgres provisioning

**What changed:** Re-evaluated the Postgres-substrate decision under a prerequisite recheck. The CLI already hard-requires Docker or Podman, so the embedded-binary options were unnecessary. Implemented as individual `docker run` calls — revealed networking issues that iteration 15 fixes with Docker Compose.

**Superseded by iteration 15** — the individual `docker run` approach caused inter-container networking failures. See iteration 15 for the current design.

---

## Iteration 13 (2026-07-01) — Deep Postgres Options Research

**What changed:** Late research agent completed with exhaustive 11-option evaluation. Created `09-postgres-options-deep-research.md` with download counts, maturity assessments, and 5 pragmatic paths.

**Key new findings vs 08:**
- PGlite has 10M DL/wk but is architecturally incompatible (single-user mode, no LISTEN/NOTIFY, Bun compile broken)
- `@boomship/postgres-vector-embedded` has only 14 DL/wk — much riskier than initially assessed
- `embedded-postgres` (leinelissen) has 189K DL/wk and 4 years of maintenance — most mature, but no pgvector
- New paths: C (PGlite for app + real PG for DBOS), D (adapt DBOS to single-conn), E (wait for DBOS TS SQLite PR #1288)
- Also evaluated and ruled out: pg-embedded, pg-mem, Neon, Supabase Local, CockroachDB, YugabyteDB, Turso, pgmock

**New artifact:**
- `09-postgres-options-deep-research.md` — 11 options with npm stats, gap analysis matrix, 5 forward paths

---

## Iteration 11-12 (2026-07-01) — Postgres Shipping Research

**What changed:** Researched all options for shipping Postgres with the CLI binary. Created `08-postgres-shipping.md`.

**Key findings:**
- **PGlite is out** — Bun compile blocker (bun#15032) + single-connection mode incompatible with DBOS
- **`@boomship/postgres-vector-embedded` is the primary choice** — bundles real Postgres + pgvector, supports multi-connection, works on darwin + linux
- **Docker is the fallback** — needed for Windows (no embedded-postgres-vector support) and as general backup
- Binaries downloaded on first use (~60-150MB), cached at `~/.inflexa/data/postgres-runtime/`
- CLI binary stays small — Postgres runtime is separate

**New artifact:**
- `08-postgres-shipping.md` — decision table (5 options), tiered fallback strategy, lifecycle management sketch, Windows gap analysis, effort estimate (~16hr)

---

## Iteration 10 (2026-07-01) — Reconcile Implementation Checklist

**What changed:** Reconciled `05-implementation-checklist.md` with `07-postgres-dbos-constraint.md` findings. Added status banner marking Phase 3 as partially outdated, and new Section 6 with three forward paths (embedded Postgres ~10hr, passthrough mode ~13-18hr, wait for DBOS TS SQLite ~27-32hr).

---

## Iteration 8-9 (2026-07-01) — Postgres/DBOS Constraint + Storage Interface Research

**What changed (iter 8):** Discovered CRITICAL architecture gap — harness requires Postgres + DBOS + pgvector; CLI uses SQLite.

**What changed (iter 9):** Deep research into DBOS SQLite support and storage interface effort.

**Key findings:**
1. **DBOS does NOT support SQLite** — confirmed by codebase agent (DBOS configures via PostgreSQL connection string at `runtime/dbos.ts:68-98`) and by specs (`postgres-storage-backend/spec.md:1-5` and `cortex-state-layer/spec.md:7-8` explicitly rule out SQLite/LibSQL)
2. **Postgres-specific SQL is translatable** (param style, timestamps, upserts) but **pgvector** and **DBOS** have no SQLite equivalents
3. **Storage interface effort: ~20-25hr** for app tables (48 files, ~64 queries) — but DBOS itself (128+ calls) can't be replaced by a storage interface
4. **Two-pool architecture** (app pool + DBOS system pool) in `runtime/pools.ts` — both Postgres

**Revised options:**
- Option A: Embedded Postgres (fastest — ~5hr, full compatibility)
- Option B: Bypass DBOS with `passthroughStep` (~10-15hr, no crash recovery)
- Option C: Storage interface + embedded Postgres for DBOS (~25hr hybrid)
- Option D: Start with embedded Postgres, abstract later (recommended — ~5hr now, defer abstraction)

**Recommendation:** Option D — embedded Postgres first. The storage interface is a ~25hr investment that needs maintenance as harness evolves; DBOS can't be abstracted away regardless.

**Artifact updated:**
- `07-postgres-dbos-constraint.md` — completely rewritten with DBOS research, SQL feature inventory, storage interface sketch + effort estimate, 4 revised options, embedded-postgres evaluation

---

## Iteration 7 (2026-07-01) — Spec Conformance + treediff Review

**What changed:** Read both governing OpenSpec specs (`sandbox-provenance-tracking/spec.md`, `exec-provenance-lineage/spec.md`) and `treediff.go`. Verified all spec requirements are met by the implementation. Added spec conformance table and treediff clarification to `06-sandbox-provenance-review.md`.

**Source files read:**
- `harness/openspec/specs/sandbox-provenance-tracking/spec.md` (293 lines) — 10 formal requirements, 20 scenarios
- `harness/openspec/specs/exec-provenance-lineage/spec.md` (109 lines) — 3 formal requirements, 7 scenarios
- `images/sandbox-base/server/treediff.go` (126 lines) — periodic directory differ (NOT provenance)

**Key findings:**
- All 13 spec requirements are met by the implementation — no spec violations
- `treediff.go` is NOT a provenance system — it's a UI progress mechanism for showing file changes during execution
- The `python -S` limitation is explicitly documented in the spec (lines 89-94) as a known limitation

**Artifact updated:**
- `06-sandbox-provenance-review.md` — added spec references header, spec conformance tables (section 9), treediff clarification

---

## Iteration 6 (2026-07-01) — Sandbox Provenance Deep Review

**What changed:** Read all sandbox provenance hook source files in full. Reviewed for correctness, bugs, coverage gaps, and unnecessary/harmful behavior.

**Source files read (all in full):**
- `images/sandbox-base/provenance/sitecustomize.py` (89 lines) — Python PEP 578 audit hook
- `images/sandbox-base/provenance/provtrack.c` (345 lines) — C LD_PRELOAD interceptor
- `images/sandbox-base/provenance/Rprofile.site` (201 lines) — R trace hooks
- `images/sandbox-base/server/provenance.go` (327 lines) — Go socket aggregator
- `images/sandbox-base/server/provenance_inotify_linux.go` (168 lines) — Linux inotify watcher
- `images/sandbox-base/server/provenance_inotify_stub.go` (14 lines) — macOS no-op
- `images/sandbox-base/server/executor.go` (lines 120-210) — provenance lifecycle in command execution

**Key findings (15 total in the review doc):**
- **No bugs found** — all 4 layers are correctly implemented
- **Nothing extra/bad** — hooks only observe, never modify operations; fail silently; filter to data prefixes
- **Coverage gaps (all mitigated by redundancy):**
  - C hook: `realpath()` drops writes to new files via relative paths (Finding 5) — mitigated by Python hook + inotify
  - R hook: doesn't track `gzfile()`/`bzfile()` connection objects (Finding 8) — mitigated by LD_PRELOAD + inotify
  - R hook: doesn't track `pdf()`/`png()` graphics device writes (Finding 9) — mitigated by LD_PRELOAD + inotify
  - inotify: doesn't watch newly-created subdirectories (Finding 14) — mitigated by Python/C hooks
- **Everything will be reported** via at least one layer for all practical bioinformatics scenarios

**New artifact:**
- `06-sandbox-provenance-review.md` — 15 findings, coverage matrix, overhead assessment, recommendations

---

## Iteration 5 (2026-07-01) — Implementation Checklist + Data Profile

**What changed:** Read `data-profile.ts` (510 lines) to understand the CLI→harness staging trigger path. Analyzed DBOS durability implications for `Bus.emit` inside workflows. Created the concrete implementation checklist.

**Source files read:**
- `harness/src/tasks/data-profile.ts` — full read (510 lines). Key: `triggerDataProfile()` at line 457, `DataProfileTriggerParams { auth, analysisId, stagedInputs }` at line 387-391, `DataProfileWorkflowInput.stagedInputs` at line 95

**Key findings:**
1. **CLI→harness staging path is clear:** CLI's `stageInputs()` produces `StagedInput[]` → passes to `triggerDataProfile()` → rides in DBOS workflow input → data-profile body iterates `stagedInputs` for artifact registration and sandbox prompt construction
2. **DBOS durability is a non-issue:** `Bus.emit` is synchronous in-memory dispatch; on crash recovery, DBOS replays workflow steps which re-trigger the injected `emitProvenance` callback; tsprov's `unified()` deduplicates by QName
3. **`inputArtifactPath(f)` at `data-profile.ts:111`** computes `"data/{f.relativePath}"` — confirms the path convention matches CLI staging's `relativePath: "inputs/local/{key}"`

**New artifact:**
- `05-implementation-checklist.md` — phased PR plan (5 phases, ~5hr estimated): fix stash → build adapter → wire composition root → add run lifecycle events → test + cleanup

**Remaining for future iterations:**
- User decision needed on ProvFileRef.producer: accept data loss (Option A) or carry rich metadata (Option B)
- Further refinement of test plan once stash is applied

---

## Iteration 4 (2026-07-01) — TODO(consider) Feedback + Stash Validation

**What changed:** Addressed both `TODO(consider)` annotations from the user. Validated stash event types against actual harness source via background agent + spot-checks.

**Findings:**
1. **tsprov in harness: NO** — raw events follow DI pattern, avoid double serialization, TypeScript unions already give type safety
2. **Stash is NOT fully grounded** — 5 misalignments found between stash payload types and harness reality:
   - `ProvRunOutcome.status` covers only 3 of 6 actual `RunStatus` values (missing `partial`, `suspended_insufficient_funds`)
   - `ProvStepRef.command/exitCode` are per-file in harness, not per-step
   - `ProvFileRef.producer` is a string discriminant but harness has rich Producer objects
   - `ProvRunRef.goal` has no backing — harness has `planSummary`
   - `ProvFileRef.path` format: step-relative (harness) vs analysis-relative (stash)

**Artifacts updated:**
- `01-provenance-migration.md` — replaced both TODO(consider) with grounded analysis; added "Should tsprov be in harness?" section and "Stash Groundedness Assessment" with 5 mismatches + fixes

**What remains:**
- Update the stash code to fix the 5 misalignments before applying
- Draft the concrete PR implementation checklist
- Investigate DBOS durability: can provenance emit callbacks run inside DBOS workflow steps?

---

## Iteration 3 (2026-07-01) — Composition & Wiring

**What changed:** Read the composition root (`assembleCoreRuntime`), workflow bodies (`execute-analysis.ts`, `sandbox-step.ts`), and the public API surface (`index.ts`). Traced the ArtifactRegistry wiring path from composition root through sandbox-step to post-step pipeline. Confirmed the harness has NO Bus — provenance events must flow through injected callbacks.

**Source files read this iteration:**
- `harness/src/runtime/assemble.ts` — assembleCoreRuntime (97 lines)
- `harness/src/workflows/sandbox-step.ts` — SandboxStepDeps (incl. artifactRegistry field at line 239)
- `harness/src/workflows/execute-analysis.ts` — ExecuteAnalysisDeps, emitStreamPart, collectAndComplete
- `harness/src/index.ts` — public API barrel (71 lines)
- grep: zero `Bus` imports in harness/src/

**New artifact:**
- `04-composition-wiring.md` — Complete wiring plan: where ArtifactRegistry is threaded, where run lifecycle events should be emitted, how the CLI's Bus connects to the harness through DI, the ProvenanceCollector name collision, and a concrete CLI composition root sketch

**Key findings:**
1. ArtifactRegistry flows: `CoreWorkflowDeps.sandboxStep.artifactRegistry` → `sandbox-step.ts` → `post-step-pipeline.ts:152` → `artifact-registration.ts:45` → `registry.register()`
2. The harness has zero Bus/EventEmitter imports — it's purely DI-driven
3. `prov.run_started`/`prov.run_completed` should be emitted from `execute-analysis.ts` via a new `emitProvenance` callback in `ExecuteAnalysisDeps` (Option A)
4. Two types named `ProvenanceCollector` exist — workspace seam (single `recordSnapshot()` method) vs step-level class (full lineage tracking). Already aliased in `shared.ts` as `LineageCollector`.
5. The `BusProvenanceAdapter` should live in the CLI (not harness) since it depends on the Bus

**Artifacts produced (4 total):**
- `00-progress.md` — this file
- `01-provenance-migration.md` — architecture comparison, what stays/goes, event schema, design decisions
- `02-file-materialization.md` — StagedInput contract, staging module, workspace layout, mount strategy
- `03-prior-work-inventory.md` — stash contents, staging module assessment
- `04-composition-wiring.md` — assembly flow, ArtifactRegistry threading, Bus bridging, wiring plan

**What remains for future iterations:**
- Draft a concrete file-by-file implementation checklist (PR scope)
- Investigate DBOS durability implications: can `Bus.emit` run safely inside a DBOS workflow step?
- Check if the stash applies cleanly to current HEAD (`git stash pop` feasibility)
- Verify `data-profile.ts` workflow for input staging integration points

---

## Iteration 2 (2026-07-01) — Source-Verified

Read all key source files directly. Verified type shapes, function signatures, and stash diff. Resolved all 4 design questions (granularity, lineage, layer data, signing scope). Added file:line references throughout.

## Iteration 1 (2026-07-01) — Initial Research

Dispatched 4 parallel research agents (harness provenance, CLI tsprov, stash/staging, harness file materialization). All completed. Established the baseline understanding of both systems.
