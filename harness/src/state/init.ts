/**
 * Cortex state table initialization.
 *
 * Creates `cortex_*` tables on startup using `CREATE TABLE IF NOT EXISTS` +
 * additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. The whole flow is
 * serialized across concurrent replicas with a Postgres advisory lock so
 * simultaneous startups don't race on DDL.
 */

import type { Pool } from "pg";
import { backfillAiSdkMessageEnvelopes } from "../memory/message-backfill.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";

const DDL = `
-- Analysis-level state (status, context, data-profile tracking, billing identity).
--
-- User identity is derived from the ambient credential's JWT sub claim
-- at request time — not persisted in this table.
CREATE TABLE IF NOT EXISTS cortex_analysis_state (
  analysis_id               TEXT PRIMARY KEY,
  status                    TEXT NOT NULL,
  context                   TEXT,
  billing_context           JSONB,
  -- Nullable: NULL is the honest "no profile" state, which loadDataProfileStatus
  -- collapses to null so a cleared profile is indistinguishable from one that never
  -- existed. The 'pending' default still applies to a row inserted without a status --
  -- a freshly-seeded analysis awaiting its first profile.
  data_profile_status       TEXT DEFAULT 'pending',
  data_profile_error        TEXT,
  data_profile_started_at   TEXT,
  data_profile_completed_at TEXT,
  data_profile_result       JSONB,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

-- File registry — artifact_id (provenance) + file_id (S3), cross-run.
CREATE TABLE IF NOT EXISTS cortex_artifacts (
  analysis_id   TEXT NOT NULL,
  path          TEXT NOT NULL,
  hash          TEXT NOT NULL,
  size          BIGINT NOT NULL,
  role          TEXT NOT NULL,
  source_step   TEXT,
  source_run    TEXT,
  artifact_id   TEXT,
  file_id       TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (analysis_id, path)
);

CREATE INDEX IF NOT EXISTS idx_cortex_artifacts_run
  ON cortex_artifacts(analysis_id, source_run);
CREATE INDEX IF NOT EXISTS idx_cortex_artifacts_artifact
  ON cortex_artifacts(analysis_id, artifact_id);

-- Run ledger — one row per workflow execution.
CREATE TABLE IF NOT EXISTS cortex_runs (
  run_id              TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL,
  thread_id           TEXT,
  workflow_name       TEXT NOT NULL,
  status              TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  completed_at        TEXT,
  error               TEXT,
  -- Run-level synthesis outcome. NULL means "unknown": a legacy row written
  -- before these columns existed, or a run whose synthesis never recorded a result.
  synthesis_status    TEXT,
  synthesis_reason    TEXT,
  parts               JSONB,
  mandate_jti         TEXT, -- oss-core-managed-ok run-mandate ledger, nullable, OSS leaves null
  mandate_expires_at  TEXT -- oss-core-managed-ok run-mandate ledger, nullable, OSS leaves null
);

CREATE INDEX IF NOT EXISTS idx_cortex_runs_analysis
  ON cortex_runs(analysis_id);
CREATE INDEX IF NOT EXISTS idx_cortex_runs_thread
  ON cortex_runs(thread_id);

-- Step execution ledger — one row per step execution.
CREATE TABLE IF NOT EXISTS cortex_step_executions (
  run_id           TEXT NOT NULL,
  step_id          TEXT NOT NULL,
  analysis_id      TEXT NOT NULL,
  wave             INTEGER NOT NULL,
  agent_id         TEXT NOT NULL,
  status           TEXT NOT NULL,
  started_at       TEXT,
  completed_at     TEXT,
  duration_ms      BIGINT,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 1,
  last_error_class TEXT,
  finish_reason    TEXT,
  hit_max_steps    INTEGER NOT NULL DEFAULT 0,
  blocked_reason   TEXT,
  PRIMARY KEY (run_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_cortex_step_exec_analysis
  ON cortex_step_executions(analysis_id);

-- Analysis plans — persisted by generatePlan, consumed by showUser and executePlan.
-- Immutable, append-only. Iteration produces a new row linked via parent_plan_id.
CREATE TABLE IF NOT EXISTS cortex_plans (
  plan_id         TEXT PRIMARY KEY,
  analysis_id     TEXT NOT NULL
                    REFERENCES cortex_analysis_state(analysis_id)
                    ON DELETE CASCADE,
  plan            JSONB NOT NULL,
  parent_plan_id  TEXT
                    REFERENCES cortex_plans(plan_id)
                    ON DELETE SET NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cortex_plans_analysis
  ON cortex_plans(analysis_id, created_at DESC);

-- Target assessments — organization-scoped, snapshot-style target dossiers.
-- Independent of analyses, projects, runs, and chat threads. The full
-- dossier is persisted as JSONB on the row, no separate artifacts table.
CREATE TABLE IF NOT EXISTS cortex_target_assessments (
  id                 UUID PRIMARY KEY,
  organization_id    TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  target_label       TEXT NOT NULL,
  goal               TEXT,
  status             TEXT NOT NULL,
  progress           TEXT,
  dossier            JSONB,
  billing_context_id TEXT NOT NULL,
  error              JSONB,
  requested_by       TEXT NOT NULL,
  workflow_run_id    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ
);

ALTER TABLE cortex_target_assessments
  ADD COLUMN IF NOT EXISTS workflow_run_id TEXT;

-- DBOS workflow id for the executeTargetAssessment workflow. For DBOS-shaped
-- rows, workflow_id = assessmentId (the workflowID passed to DBOS.startWorkflow).
-- Nullable so older rows tolerate NULL -- new rows always write
-- workflow_id alongside the row insert.
ALTER TABLE cortex_target_assessments
  ADD COLUMN IF NOT EXISTS workflow_id TEXT;

CREATE INDEX IF NOT EXISTS idx_cortex_target_assessments_workflow_id
  ON cortex_target_assessments(workflow_id);

CREATE INDEX IF NOT EXISTS idx_cortex_target_assessments_org_created
  ON cortex_target_assessments(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cortex_target_assessments_org_target_created
  ON cortex_target_assessments(organization_id, target_id, created_at DESC);

-- Per-row clinical-consequence annotations for off-target hits, produced by
-- a focused LLM annotator. Cached by (primary_target_gene, off_target_key)
-- so repeat assessments of the same target reuse prior work and avoid
-- per-run LLM cost.
--
-- off_target_key is the ChEMBL ID when present, else the (trimmed,
-- lowercased) off-target name. Composite primary key prevents duplicate
-- annotations.
CREATE TABLE IF NOT EXISTS cortex_off_target_annotations (
  primary_target_gene  TEXT NOT NULL,
  off_target_key       TEXT NOT NULL,
  off_target_name      TEXT NOT NULL,
  clinical_consequence TEXT NOT NULL,
  provenance           TEXT,
  model                TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (primary_target_gene, off_target_key)
);

-- Regulatory guidance corpus — pre-indexed FDA CDER, FDA CBER, and ICH
-- guidance documents. Written/refreshed via tasks/refresh-regulatory-corpus.ts
-- and searched (top-K cosine) via lib/regulatory-corpus.ts. No synthesis tool
-- consumes it yet — a search_regulatory_guidance tool is not wired.
CREATE TABLE IF NOT EXISTS cortex_regulatory_chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source          TEXT NOT NULL,
  doc_id          TEXT NOT NULL,
  doc_title       TEXT NOT NULL,
  doc_url         TEXT NOT NULL,
  section         TEXT,
  chunk_index     INTEGER NOT NULL,
  chunk_text      TEXT NOT NULL,
  embedding       vector(1536),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cortex_regulatory_chunks_source_doc
  ON cortex_regulatory_chunks(source, doc_id);

CREATE INDEX IF NOT EXISTS idx_cortex_regulatory_chunks_metadata
  ON cortex_regulatory_chunks USING gin (metadata);

-- Conversation message store — the harness ThreadHistory module's table.
-- One row per message, with seq monotonic per thread. message_envelope holds
-- AI SDK ModelMessage envelopes and tokens is counted at write time, so the
-- read path never tokenizes. Legacy role/content_jsonb columns are nullable
-- and write-frozen — they exist only for startup backfill/inspection and
-- should be dropped after the migration window. Conversation-scoped only —
-- workflow and sandbox agent loops use the DBOS step cache, never this
-- table (see the harness-thread-store spec). The (thread_id, seq) primary key already serves
-- (thread_id, seq DESC) reads, so no separate index is needed.
CREATE TABLE IF NOT EXISTS messages (
  thread_id     TEXT NOT NULL,
  seq           BIGINT NOT NULL,
  role          TEXT,
  content_jsonb JSONB,
  message_envelope JSONB,
  tokens        INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, seq)
);

-- Conversation thread metadata — the harness ThreadStore module's table,
-- one row per conversation thread. Holds the analysis-scope, title, and
-- soft-delete tombstone the harness messages table deliberately lacks.
-- No free-form metadata column: working memory lives in cortex_working_memory;
-- nothing else reads thread metadata. A NULL deleted_at means the thread is live.
CREATE TABLE IF NOT EXISTS cortex_analysis_threads (
  thread_id   TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL,
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cortex_analysis_threads_analysis
  ON cortex_analysis_threads(analysis_id) WHERE deleted_at IS NULL;

-- Working memory — the harness WorkingMemory module's table, one row per
-- analysis. The data column holds a JSONB object with four sections (goal,
-- constraints, hypotheses, findings). Section updates are a read-modify-write
-- in harness/memory/working-memory.ts, not a whole-blob rewrite.
-- Analysis-scoped and agent-maintained.
CREATE TABLE IF NOT EXISTS cortex_working_memory (
  analysis_id TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tool-approval ask ledger — the single source of truth for approval state, one
-- row per ctx.ask invocation. ctx.ask inserts a 'pending' row and polls it to a
-- terminal status. The outward answer() writes the decision. reply holds the
-- recorded AskReply (NULL while pending). Analysis-scoped audit of every
-- approval-gated action, including grant auto-approvals (recorded 'resolved'
-- with no prompt shown). A pending row a dead process orphans is swept to
-- 'expired' at boot.
CREATE TABLE IF NOT EXISTS cortex_asks (
  id           TEXT PRIMARY KEY,
  analysis_id  TEXT NOT NULL,
  thread_id    TEXT,
  title        TEXT NOT NULL,
  command      TEXT NOT NULL,
  detail       TEXT,
  status       TEXT NOT NULL,
  reply        JSONB,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_cortex_asks_analysis
  ON cortex_asks(analysis_id);

-- Backs the pending() enumeration and the boot sweep. Partial so it stays
-- compact against the far larger terminal-row mass.
CREATE INDEX IF NOT EXISTS idx_cortex_asks_pending
  ON cortex_asks(status) WHERE status = 'pending';

-- Standing approval grants behind an 'always' reply — keyed by the analysis and
-- the exact command string the user approved, so a later matching ask
-- auto-approves without pausing. Lives for the analysis lifecycle, surviving
-- process restarts, and never applies to another analysis.
CREATE TABLE IF NOT EXISTS cortex_ask_grants (
  analysis_id  TEXT NOT NULL,
  command      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (analysis_id, command)
);
`;

/**
 * Initialize Cortex state tables. Safe to call on every startup and across
 * concurrent replicas (advisory lock serializes the init flow).
 */
export async function initCortexState(pool: Pool, injected?: Logger): Promise<void> {
    const logger = (injected ?? createNoopLogger()).named("cortex-state");
    const client = await pool.connect();
    try {
        // Serialize concurrent replica startups — cheap, no extra tooling.
        await client.query("SELECT pg_advisory_lock(hashtext('cortex_state_init'))");

        try {
            // pgvector must be present for the per-analysis search indexes. We
            // tolerate an already-present extension, but fail loudly on any other
            // error so operators see a clear infra-pointer message.
            try {
                await client.query("CREATE EXTENSION IF NOT EXISTS vector");
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!/already exists/i.test(msg)) {
                    throw new Error(
                        `Cortex requires the pgvector extension. ` +
                            `CREATE EXTENSION IF NOT EXISTS vector failed: ${msg}. ` +
                            `Ask platform-infra to enable pgvector on the RDS parameter group, ` +
                            `or grant CREATE on the database to the Cortex role.`,
                        { cause: err },
                    );
                }
            }

            // Base DDL — idempotent via CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
            const statements = DDL.split(";")
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
            for (const sql of statements) {
                await client.query(sql);
            }

            // Drop vestigial columns/tables from pre-v2 databases. Idempotent:
            // each statement targets a specific column that may or may not exist;
            // `DROP COLUMN IF EXISTS` is a no-op when absent.
            const dropMigrations = [
                "DROP TABLE IF EXISTS cortex_run_events",
                "ALTER TABLE cortex_step_executions DROP COLUMN IF EXISTS thread_id",
                "ALTER TABLE cortex_step_executions DROP COLUMN IF EXISTS execution_id",
                "ALTER TABLE cortex_step_executions DROP COLUMN IF EXISTS resources",
                "ALTER TABLE cortex_step_executions DROP COLUMN IF EXISTS summary",
                "ALTER TABLE cortex_artifacts DROP COLUMN IF EXISTS description",
                "ALTER TABLE cortex_artifacts DROP COLUMN IF EXISTS metadata",
                "ALTER TABLE cortex_analysis_state DROP COLUMN IF EXISTS profile",
                "ALTER TABLE cortex_analysis_state DROP COLUMN IF EXISTS input_files",
                "ALTER TABLE cortex_analysis_state DROP COLUMN IF EXISTS user_id",
                // v2 vestiges on cortex_runs.
                "ALTER TABLE cortex_runs DROP COLUMN IF EXISTS plan",
                "ALTER TABLE cortex_runs DROP COLUMN IF EXISTS plan_version",
                "ALTER TABLE cortex_runs DROP COLUMN IF EXISTS current_wave",
                "ALTER TABLE cortex_runs DROP COLUMN IF EXISTS suspension",
                // The mandate JWT lives in DBOS workflow input (never reconstructed -- oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
                // from the DB), and `run_id` is the DBOS workflowID directly — no
                // separate `workflow_id` column.
                "ALTER TABLE cortex_runs DROP COLUMN IF EXISTS mandate_token", // oss-core-managed-ok: drop-migration for removed branded column
                "ALTER TABLE cortex_runs DROP COLUMN IF EXISTS workflow_id",
                "DROP INDEX IF EXISTS idx_cortex_runs_workflow",
            ];
            for (const sql of dropMigrations) {
                await client.query(sql);
            }

            // If an older DB had `cortex_runs.thread_id NOT NULL`, relax it now.
            // Safe no-op when already nullable.
            await client.query("ALTER TABLE cortex_runs ALTER COLUMN thread_id DROP NOT NULL");

            // Legacy Anthropic message columns are write-frozen: runtime writes
            // only message_envelope, so new rows must not require them. The
            // columns should be dropped entirely after the migration window.
            await client.query("ALTER TABLE messages ALTER COLUMN role DROP NOT NULL");
            await client.query("ALTER TABLE messages ALTER COLUMN content_jsonb DROP NOT NULL");

            // Additive migrations — columns that may not exist on older DBs.
            const addMigrations = [
                "ALTER TABLE cortex_runs ADD COLUMN IF NOT EXISTS thread_id TEXT",
                "ALTER TABLE cortex_runs ADD COLUMN IF NOT EXISTS parts JSONB",
                "ALTER TABLE cortex_runs ADD COLUMN IF NOT EXISTS mandate_jti TEXT", // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
                "ALTER TABLE cortex_runs ADD COLUMN IF NOT EXISTS mandate_expires_at TEXT", // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
                "ALTER TABLE cortex_runs ADD COLUMN IF NOT EXISTS synthesis_status TEXT",
                "ALTER TABLE cortex_runs ADD COLUMN IF NOT EXISTS synthesis_reason TEXT",
                "ALTER TABLE cortex_analysis_state ADD COLUMN IF NOT EXISTS data_profile_result JSONB",
                "ALTER TABLE cortex_analysis_state ADD COLUMN IF NOT EXISTS billing_context JSONB",
                // Sandbox reliability telemetry (from sandbox-reliability change on main).
                "ALTER TABLE cortex_step_executions ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1",
                "ALTER TABLE cortex_step_executions ADD COLUMN IF NOT EXISTS last_error_class TEXT",
                "ALTER TABLE cortex_step_executions ADD COLUMN IF NOT EXISTS finish_reason TEXT",
                "ALTER TABLE cortex_step_executions ADD COLUMN IF NOT EXISTS hit_max_steps INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE cortex_step_executions ADD COLUMN IF NOT EXISTS blocked_reason TEXT",
                "ALTER TABLE cortex_runs ADD COLUMN IF NOT EXISTS plan_id TEXT REFERENCES cortex_plans(plan_id) ON DELETE SET NULL",
                // Promote overflow-prone numeric columns from int4 to int8.
                // File sizes >2 GB and durations >~24.8 days previously failed INSERT
                // with "value ... is out of range of type integer".
                "ALTER TABLE cortex_artifacts ALTER COLUMN size TYPE BIGINT",
                "ALTER TABLE cortex_step_executions ALTER COLUMN duration_ms TYPE BIGINT",
                "ALTER TABLE cortex_artifacts ADD COLUMN IF NOT EXISTS unrecoverable_at TEXT",
                "ALTER TABLE cortex_artifacts ADD COLUMN IF NOT EXISTS file_type TEXT",
                // Active-sandbox registry — sandbox_ref carries {sandboxId, host, port,
                // backend} (no callbackSecret — that lives only in the DBOS step-output
                // cache). exec_id carries the currently in-flight workflowId:stepId:fnId.
                // Partial index supports the watchdog's registry query
                // (status='running' AND sandbox_ref IS NOT NULL); kept partial so it
                // stays compact against the much larger terminal-row mass.
                "ALTER TABLE cortex_step_executions ADD COLUMN IF NOT EXISTS sandbox_ref JSONB",
                "ALTER TABLE cortex_step_executions ADD COLUMN IF NOT EXISTS exec_id TEXT",
                "CREATE INDEX IF NOT EXISTS idx_cortex_step_exec_active_sandbox " + "ON cortex_step_executions(status) WHERE sandbox_ref IS NOT NULL",
                // DBOS workflow addressing. `cortex_runs.run_id` IS the parent DBOS
                // workflowID — both are the same bare UUID. `child_workflow_id` maps
                // each step-execution row to its DBOS child workflow id.
                // Partial-unique index — at most one active run per (analysis_id, plan_id).
                // Terminal rows are excluded so a deliberate re-run after completion
                // succeeds; a concurrent double-trigger raises unique-violation and the
                // caller resolves to the existing active runId via queryActiveRun.
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_cortex_runs_active_plan " +
                    "ON cortex_runs(analysis_id, plan_id) " +
                    "WHERE status IN ('running','suspended_insufficient_funds')",
                "ALTER TABLE cortex_step_executions ADD COLUMN IF NOT EXISTS child_workflow_id TEXT",
                "CREATE INDEX IF NOT EXISTS idx_cortex_step_exec_child_workflow " + "ON cortex_step_executions(child_workflow_id)",
                "ALTER TABLE cortex_analysis_state ADD COLUMN IF NOT EXISTS seed_input_file_ids JSONB",
                // Databases created before `data_profile_status` became nullable still
                // carry the NOT NULL floor, which would reject a clear. Idempotent:
                // dropping an absent NOT NULL no-ops, so this is a no-op on fresh DBs.
                "ALTER TABLE cortex_analysis_state ALTER COLUMN data_profile_status DROP NOT NULL",
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_envelope JSONB",
            ];
            for (const sql of addMigrations) {
                await client.query(sql);
            }
            await backfillAiSdkMessageEnvelopes(client);

            // HNSW ANN index on cortex_regulatory_chunks.embedding. HNSW gives
            // higher recall than ivfflat at the same latency and needs no
            // training step — the right pick for a write-occasionally /
            // read-many corpus (quarterly refresh, multiple search calls per
            // synthesis step).
            //
            // Requires pgvector >= 0.5.0. Tolerated gracefully on older
            // versions — the table and B-tree/GIN indexes still work; the
            // operator can build this index manually once they upgrade pgvector.
            // m and ef_construction are conservative defaults; tune after
            // measuring recall vs. latency on the production corpus size.
            try {
                await client.query(
                    `CREATE INDEX IF NOT EXISTS idx_cortex_regulatory_chunks_embedding
           ON cortex_regulatory_chunks USING hnsw (embedding vector_cosine_ops)
           WITH (m = 16, ef_construction = 64)`,
                );
            } catch (err) {
                logger.warn(
                    "could not create HNSW index on cortex_regulatory_chunks.embedding (pgvector < 0.5.0 or operator class unavailable) — " +
                        "cosine similarity queries fall back to sequential scan; upgrade pgvector and re-run init to get the ANN index",
                    logger.errorFields(err),
                );
            }

            // No boot-time orphan sweep on cortex_runs / cortex_step_executions.
            // Every running row is backed by a DBOS workflow (executeAnalysis,
            // executeTargetAssessment, resume entry); DBOS recovery is the
            // substitute — each pod has a stable executorID (StatefulSet pod name)
            // and runs `recoverPendingWorkflows` for its own ID at launch (ADR
            // 0012). The workflow body owns the terminal transition on cortex_runs;
            // a bulk fail here would race recovery and mark healthy sibling-replica
            // runs as failed.
        } finally {
            await client.query("SELECT pg_advisory_unlock(hashtext('cortex_state_init'))");
        }
    } finally {
        client.release();
    }
}
