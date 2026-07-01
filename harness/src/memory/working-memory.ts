/**
 * Working memory — the harness's structured, analysis-scoped interpretive
 * store.
 *
 * Structured JSONB object the agent updates one section at a time, serialized
 * to Markdown only when injected (see the harness-thread-store spec).
 *
 * Four sections. `goal`, `constraints`, `hypotheses` are analysis-flat;
 * `findings` is run-scoped, keyed by `runId`, so a finding stays attributable
 * to the run that produced it. There is deliberately no `context` section —
 * analysis context lives in `cortex_analysis_state.context` and is injected
 * separately by the chat route.
 *
 * `updateSection` is a section-addressable read-modify-write: the named
 * section is replaced or amended and the other three are left byte-identical.
 */

import type { ResultAsync } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { type DbError, tryMutation, tryQuery, withTransaction } from "../lib/db-result.js";

/** A binding rule — user-stated or agent-derived. The highest-value section. */
export const constraintSchema = z.object({
    id: z.string(),
    text: z.string(),
    origin: z.enum(["user", "agent"]),
});
export type Constraint = z.infer<typeof constraintSchema>;

/** An active hypothesis under exploration. */
export const hypothesisSchema = z.object({
    id: z.string(),
    text: z.string(),
});
export type Hypothesis = z.infer<typeof hypothesisSchema>;

/** A durable conclusion, attributed to the run that produced it. */
export const findingSchema = z.object({
    id: z.string(),
    text: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

/**
 * The persisted `data` shape — one JSONB object per analysis. `findings` is
 * keyed by `runId`; an analysis with no recorded findings has an empty map.
 */
export const workingMemorySchema = z.object({
    goal: z.string(),
    constraints: z.array(constraintSchema),
    hypotheses: z.array(hypothesisSchema),
    findings: z.record(z.string(), z.array(findingSchema)),
});
export type WorkingMemory = z.infer<typeof workingMemorySchema>;

/** The shape `load` returns for an analysis with no working-memory row. */
export function emptyWorkingMemory(): WorkingMemory {
    return { goal: "", constraints: [], hypotheses: [], findings: {} };
}

/**
 * A list-section amendment: append a new entry, revise an existing one's
 * text, or retire a stale one. `revise`/`retire` address an entry by the
 * `id` the agent copies from the rendered working memory.
 */
export type ListOp =
    | { readonly op: "add"; readonly text: string }
    | { readonly op: "revise"; readonly id: string; readonly text: string }
    | { readonly op: "retire"; readonly id: string };

/** As `ListOp`, but `add` also carries the constraint's `origin`. */
export type ConstraintOp =
    | { readonly op: "add"; readonly text: string; readonly origin: "user" | "agent" }
    | { readonly op: "revise"; readonly id: string; readonly text: string }
    | { readonly op: "retire"; readonly id: string };

/** The `value` argument of `updateSection`, keyed by the `section` name. */
export interface SectionValue {
    readonly goal: { readonly text: string };
    readonly constraint: ConstraintOp;
    readonly hypothesis: ListOp;
    readonly finding: { readonly runId: string; readonly text: string };
}
export type Section = keyof SectionValue;

/**
 * The working-memory store. Three methods — `load` reads the structured
 * shape, `updateSection` amends one section, `render` serializes to the
 * Markdown the chat route injects.
 */
export interface WorkingMemoryStore {
    /** Read the row; return the empty shape if absent (no lazy insert). */
    load(analysisId: string): ResultAsync<WorkingMemory, DbError>;
    /**
     * Atomically read-modify-write one section. The other three sections are
     * left byte-identical; the row is upserted if absent.
     */
    updateSection<S extends Section>(analysisId: string, section: S, value: SectionValue[S]): ResultAsync<void, DbError>;
    /** Serialize working memory to a Markdown document for injection. */
    render(analysisId: string): ResultAsync<string, DbError>;
}

/** A short, render-friendly entry id. */
function newId(): string {
    return crypto.randomUUID().slice(0, 8);
}

function applyListOp(entries: readonly Hypothesis[], op: ListOp): Hypothesis[] {
    switch (op.op) {
        case "add":
            return [...entries, { id: newId(), text: op.text }];
        case "revise":
            return entries.map((e) => (e.id === op.id ? { ...e, text: op.text } : e));
        case "retire":
            return entries.filter((e) => e.id !== op.id);
    }
}

function applyConstraintOp(entries: readonly Constraint[], op: ConstraintOp): Constraint[] {
    switch (op.op) {
        case "add":
            return [...entries, { id: newId(), text: op.text, origin: op.origin }];
        case "revise":
            return entries.map((e) => (e.id === op.id ? { ...e, text: op.text } : e));
        case "retire":
            return entries.filter((e) => e.id !== op.id);
    }
}

/** Pure section-addressable amendment. Sibling sections are never touched. */
function applySectionUpdate<S extends Section>(wm: WorkingMemory, section: S, value: SectionValue[S]): WorkingMemory {
    switch (section) {
        case "goal":
            return { ...wm, goal: (value as SectionValue["goal"]).text };
        case "constraint":
            return {
                ...wm,
                constraints: applyConstraintOp(wm.constraints, value as SectionValue["constraint"]),
            };
        case "hypothesis":
            return {
                ...wm,
                hypotheses: applyListOp(wm.hypotheses, value as SectionValue["hypothesis"]),
            };
        case "finding": {
            const { runId, text } = value as SectionValue["finding"];
            const existing = wm.findings[runId] ?? [];
            return {
                ...wm,
                findings: {
                    ...wm.findings,
                    [runId]: [...existing, { id: newId(), text }],
                },
            };
        }
    }
    // Unreachable — `section` is exhaustively a `Section`.
    return wm;
}

/** Serialize working memory to the Markdown document injected each turn. */
export function renderWorkingMemory(wm: WorkingMemory): string {
    const lines: string[] = ["# Working Memory", ""];

    lines.push("## Goal", "");
    lines.push(wm.goal.trim().length > 0 ? wm.goal.trim() : "_none yet_", "");

    lines.push("## Constraints", "");
    if (wm.constraints.length === 0) {
        lines.push("_none yet_");
    } else {
        for (const c of wm.constraints) {
            lines.push(`- [${c.id}] (${c.origin}) ${c.text}`);
        }
    }
    lines.push("");

    lines.push("## Hypotheses", "");
    if (wm.hypotheses.length === 0) {
        lines.push("_none yet_");
    } else {
        for (const h of wm.hypotheses) {
            lines.push(`- [${h.id}] ${h.text}`);
        }
    }
    lines.push("");

    lines.push("## Findings", "");
    const runIds = Object.keys(wm.findings);
    if (runIds.length === 0) {
        lines.push("_none yet_");
    } else {
        for (const runId of runIds) {
            lines.push(`### Run ${runId}`, "");
            const findings = wm.findings[runId] ?? [];
            if (findings.length === 0) {
                lines.push("_none yet_");
            } else {
                for (const f of findings) {
                    lines.push(`- [${f.id}] ${f.text}`);
                }
            }
            lines.push("");
        }
    }

    return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Create a `WorkingMemoryStore` bound to a Postgres pool — a factory closure
 * capturing `pool` (dependency injection per the harness-durable-runtime spec). The
 * `cortex_working_memory` table is provisioned by the project's state-init
 * DDL.
 */
export function createWorkingMemory(pool: Pool): WorkingMemoryStore {
    function load(analysisId: string): ResultAsync<WorkingMemory, DbError> {
        // The driver read is the only thing wrapped; `workingMemorySchema.parse`
        // runs in `.map` so a schema-validation throw propagates verbatim rather
        // than being miscaptured as a `DbError`.
        return tryQuery("working-memory.load", () =>
            pool.query<{ data: unknown }>("SELECT data FROM cortex_working_memory WHERE analysis_id = $1", [analysisId]),
        ).map(({ rows }) => (rows.length === 0 ? emptyWorkingMemory() : workingMemorySchema.parse(rows[0]!.data)));
    }

    function updateSection<S extends Section>(analysisId: string, section: S, value: SectionValue[S]): ResultAsync<void, DbError> {
        return withTransaction(pool, "working-memory.updateSection", (client) =>
            // Serialize concurrent read-modify-write on this analysis — the lock
            // covers the not-yet-existing-row case an `SELECT ... FOR UPDATE`
            // would miss. Released automatically at COMMIT/ROLLBACK.
            tryQuery("working-memory.updateSection.lock", () => client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [analysisId]))
                .andThen(() =>
                    tryQuery("working-memory.updateSection.read", () =>
                        client.query<{ data: unknown }>("SELECT data FROM cortex_working_memory WHERE analysis_id = $1", [analysisId]),
                    ),
                )
                .map(({ rows }) => {
                    // Schema parse stays outside the driver wrapper — a validation throw
                    // propagates verbatim (and `withTransaction` still rolls back).
                    const current = rows.length === 0 ? emptyWorkingMemory() : workingMemorySchema.parse(rows[0]!.data);
                    return applySectionUpdate(current, section, value);
                })
                .andThen((next) =>
                    tryMutation("working-memory.updateSection.upsert", () =>
                        client.query(
                            `INSERT INTO cortex_working_memory (analysis_id, data, updated_at)
               VALUES ($1, $2::jsonb, NOW())
               ON CONFLICT (analysis_id)
               DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
                            [analysisId, JSON.stringify(next)],
                        ),
                    ).map(() => undefined),
                ),
        );
    }

    function render(analysisId: string): ResultAsync<string, DbError> {
        return load(analysisId).map(renderWorkingMemory);
    }

    return { load, updateSection, render };
}
