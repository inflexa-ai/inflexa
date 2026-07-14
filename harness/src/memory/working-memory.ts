/**
 * Working memory — the harness's structured, analysis-scoped interpretive
 * store.
 *
 * Structured JSONB object the agent updates one section at a time, serialized
 * to Markdown only when injected (see the harness-thread-store spec).
 *
 * Four sections. `goal`, `constraints`, `hypotheses` are analysis-flat;
 * `findings` is stored keyed by `runId`, so a finding stays attributable to
 * the run that produced it. There is deliberately no `context` section —
 * analysis context lives in `cortex_analysis_state.context` and is injected
 * separately by the chat route.
 *
 * `updateSection` is a section-addressable read-modify-write: the named
 * section is replaced or amended and the other three are left byte-identical.
 *
 * **Working memory is re-injected, in full, into the uncached tail of every
 * turn** — so every stored character is re-paid on every later turn for the
 * life of the analysis. Two consequences shape this module:
 *
 *  - **Every section is bounded at write time** (`WORKING_MEMORY_LIMITS`). An
 *    over-cap write is *rejected* with a model-actionable message, never
 *    silently truncated: the agent must shorten the text or retire a stale
 *    entry. Every section — findings included — therefore supports
 *    add/revise/retire, so memory can shrink as well as grow.
 *  - **Memory holds references to runs, never run content.** A finding cites
 *    the `runId` that produced it and renders as one line in a single flat
 *    list; the run's detail stays retrievable via `inspect_run`.
 */

import { type Result, type ResultAsync, err, ok, okAsync } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { type DbError, tryMutation, tryQuery, withTransaction } from "../lib/db-result.js";

/**
 * The write-time bounds on working memory. `updateSection` enforces them, the
 * `update_working_memory` input schema declares them to the model (importing
 * these same numbers), and `renderWorkingMemory` uses them to bound its output.
 */
export const WORKING_MEMORY_LIMITS = {
    /** Max characters in the goal. */
    goalChars: 500,
    /** Max characters in one constraint / hypothesis / finding entry. */
    entryChars: 300,
    /** Max constraint entries. */
    constraints: 20,
    /** Max hypothesis entries. */
    hypotheses: 10,
    /** Max finding entries, summed across every run. */
    findings: 30,
} as const;

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
 *
 * Deliberately unbounded: the caps are a *write-time* rule, not a read-time
 * one. A row written before the caps existed must still `load` — so this
 * schema validates shape only, and `renderWorkingMemory` bounds what an
 * oversized row is allowed to cost.
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
 * A refused write: a cap was hit, or an id addresses nothing. Not a storage
 * failure — it is an expected outcome the *model* can correct, so `message` is
 * written for the model and says what to do next (shorten this, retire that).
 * The tool surfaces it as an `is_error` tool result; the row is untouched.
 */
export interface WorkingMemoryRejection {
    readonly type: "working_memory_rejected";
    readonly message: string;
}

/** `updateSection`'s error channel: a storage failure, or a refused write. */
export type WorkingMemoryError = DbError | WorkingMemoryRejection;

/** Narrow a `WorkingMemoryError` to the model-correctable branch. */
export function isWorkingMemoryRejection(error: WorkingMemoryError): error is WorkingMemoryRejection {
    return error.type === "working_memory_rejected";
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

/**
 * As `ListOp`, but `add` also carries the `runId` the finding is attributed
 * to. `revise`/`retire` address the finding by its own id — the run holding it
 * is found from that id, so the agent never has to re-cite the run.
 */
export type FindingOp =
    | { readonly op: "add"; readonly runId: string; readonly text: string }
    | { readonly op: "revise"; readonly id: string; readonly text: string }
    | { readonly op: "retire"; readonly id: string };

/** The `value` argument of `updateSection`, keyed by the `section` name. */
export interface SectionValue {
    readonly goal: { readonly text: string };
    readonly constraint: ConstraintOp;
    readonly hypothesis: ListOp;
    readonly finding: FindingOp;
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
     * left byte-identical; the row is upserted if absent. A write that breaks a
     * cap or addresses an unknown id is refused — `err(WorkingMemoryRejection)`,
     * and the row is left exactly as it was.
     */
    updateSection<S extends Section>(analysisId: string, section: S, value: SectionValue[S]): ResultAsync<void, WorkingMemoryError>;
    /** Serialize working memory to a Markdown document for injection. */
    render(analysisId: string): ResultAsync<string, DbError>;
}

/** A short, render-friendly entry id. */
function newId(): string {
    return crypto.randomUUID().slice(0, 8);
}

function reject(message: string): Result<never, WorkingMemoryRejection> {
    return err({ type: "working_memory_rejected", message });
}

function rejectUnknownId(section: string, id: string): Result<never, WorkingMemoryRejection> {
    return reject(
        `no ${section} with id "${id}" — nothing was changed. Copy an id verbatim from the [id] shown ` +
            `against each entry in the rendered working memory, or add a new entry instead.`,
    );
}

function rejectFull(section: string, limit: number): Result<never, WorkingMemoryRejection> {
    return reject(
        `${section} is full (${limit}/${limit}) — the new entry was NOT recorded. Working memory is ` +
            `re-injected on every turn, so it is capped. Retire a stale entry first (operation "retire" ` +
            `with its id), then add this one — or drop it, if it earns its place less than everything ` +
            `already there.`,
    );
}

/** Validate one entry's text against the shared entry cap. */
function checkEntryText(section: string, text: string): Result<string, WorkingMemoryRejection> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return reject(`${section} text is empty — nothing was recorded.`);
    if (trimmed.length > WORKING_MEMORY_LIMITS.entryChars) {
        return reject(
            `${section} text is ${trimmed.length} characters — the cap is ${WORKING_MEMORY_LIMITS.entryChars}. It was ` +
                `NOT recorded. Rewrite it as one concise line and retry; keep the detail in the run itself, ` +
                `which inspect_run still serves.`,
        );
    }
    return ok(trimmed);
}

/** Amend a flat `{id, text}` list — the shared body of constraints and hypotheses. */
function applyEntryOp<T extends { id: string; text: string }>(
    entries: readonly T[],
    op: ListOp | ConstraintOp,
    section: string,
    limit: number,
    create: (text: string) => T,
): Result<T[], WorkingMemoryRejection> {
    switch (op.op) {
        case "add":
            if (entries.length >= limit) return rejectFull(section, limit);
            return checkEntryText(section, op.text).map((text) => [...entries, create(text)]);
        case "revise": {
            if (!entries.some((e) => e.id === op.id)) return rejectUnknownId(section, op.id);
            return checkEntryText(section, op.text).map((text) => entries.map((e) => (e.id === op.id ? { ...e, text } : e)));
        }
        case "retire": {
            if (!entries.some((e) => e.id === op.id)) return rejectUnknownId(section, op.id);
            return ok(entries.filter((e) => e.id !== op.id));
        }
    }
}

type Findings = WorkingMemory["findings"];

/** Findings across every run — the cap governs the section, not one run's bucket. */
function countFindings(findings: Findings): number {
    return Object.values(findings).reduce((n, list) => n + list.length, 0);
}

/** The run a finding id hangs under, or `undefined` if no run holds it. */
function runOfFinding(findings: Findings, id: string): string | undefined {
    return Object.keys(findings).find((runId) => findings[runId]!.some((f) => f.id === id));
}

function applyFindingOp(findings: Findings, op: FindingOp): Result<Findings, WorkingMemoryRejection> {
    switch (op.op) {
        case "add": {
            if (countFindings(findings) >= WORKING_MEMORY_LIMITS.findings) {
                return rejectFull("findings", WORKING_MEMORY_LIMITS.findings);
            }
            return checkEntryText("finding", op.text).map((text) => ({
                ...findings,
                [op.runId]: [...(findings[op.runId] ?? []), { id: newId(), text }],
            }));
        }
        case "revise": {
            const runId = runOfFinding(findings, op.id);
            if (runId === undefined) return rejectUnknownId("finding", op.id);
            return checkEntryText("finding", op.text).map((text) => ({
                ...findings,
                [runId]: findings[runId]!.map((f) => (f.id === op.id ? { ...f, text } : f)),
            }));
        }
        case "retire": {
            const runId = runOfFinding(findings, op.id);
            if (runId === undefined) return rejectUnknownId("finding", op.id);
            const kept = findings[runId]!.filter((f) => f.id !== op.id);
            const next = { ...findings };
            // An emptied run bucket is dropped whole: memory references a run only
            // for as long as it holds a finding from it.
            if (kept.length === 0) delete next[runId];
            else next[runId] = kept;
            return ok(next);
        }
    }
}

/**
 * Pure section-addressable amendment. Sibling sections are never touched; a
 * refused write returns `err` and the caller writes nothing.
 */
function applySectionUpdate<S extends Section>(wm: WorkingMemory, section: S, value: SectionValue[S]): Result<WorkingMemory, WorkingMemoryRejection> {
    switch (section) {
        case "goal": {
            const text = (value as SectionValue["goal"]).text.trim();
            if (text.length > WORKING_MEMORY_LIMITS.goalChars) {
                return reject(
                    `the goal is ${text.length} characters — the cap is ${WORKING_MEMORY_LIMITS.goalChars}. It was NOT ` +
                        `recorded. State the objective in a sentence or two; the supporting detail belongs in ` +
                        `constraints and findings, not in the goal.`,
                );
            }
            return ok({ ...wm, goal: text });
        }
        case "constraint": {
            const op = value as SectionValue["constraint"];
            const origin = op.op === "add" ? op.origin : "agent";
            return applyEntryOp<Constraint>(wm.constraints, op, "constraints", WORKING_MEMORY_LIMITS.constraints, (text) => ({
                id: newId(),
                text,
                origin,
            })).map((constraints) => ({ ...wm, constraints }));
        }
        case "hypothesis":
            return applyEntryOp<Hypothesis>(wm.hypotheses, value as SectionValue["hypothesis"], "hypotheses", WORKING_MEMORY_LIMITS.hypotheses, (text) => ({
                id: newId(),
                text,
            })).map((hypotheses) => ({ ...wm, hypotheses }));
        case "finding":
            return applyFindingOp(wm.findings, value as SectionValue["finding"]).map((findings) => ({ ...wm, findings }));
    }
    // Unreachable — `section` is exhaustively a `Section`.
    return ok(wm);
}

/** A finding lifted out of its run bucket, carrying the run it references. */
interface FlatFinding extends Finding {
    readonly runId: string;
}

/** Every finding, in insertion order, each carrying its run reference. */
function flattenFindings(findings: Findings): FlatFinding[] {
    return Object.entries(findings).flatMap(([runId, list]) => list.map((f) => ({ ...f, runId })));
}

/** Keep the newest `limit` entries, reporting how many older ones were dropped. */
function newest<T>(entries: readonly T[], limit: number): { shown: readonly T[]; omitted: number } {
    if (entries.length <= limit) return { shown: entries, omitted: 0 };
    return { shown: entries.slice(entries.length - limit), omitted: entries.length - limit };
}

/** Bound one entry's rendered text. Only a legacy over-cap row can hit this. */
function clamp(text: string, limit: number): string {
    const trimmed = text.trim();
    return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

function renderSection(heading: string, lines: readonly string[], omitted: number, label: string): string {
    const body = omitted > 0 ? [...lines, `- … ${omitted} older ${label} omitted — over cap; retire entries above.`] : lines;
    return `## ${heading}\n\n${body.join("\n")}`;
}

/**
 * Serialize working memory to the Markdown document injected each turn.
 *
 * Renders only what exists: an empty section is omitted entirely — no heading,
 * no placeholder — and an entirely empty memory renders to the **empty
 * string**, costing nothing. The chat route injects the render
 * unconditionally, and the provider's outbound sanitizer drops a message whose
 * content is `""` before the wire call (`providers/ai-sdk.ts`), so an empty
 * memory reaches the model as no message at all.
 *
 * Findings render as ONE flat list, each line citing the run it came from —
 * never a per-run heading block. Memory holds the reference; `inspect_run`
 * holds the run.
 *
 * The output is bounded to `WORKING_MEMORY_LIMITS` no matter what the row
 * holds. Writes are capped, so only a row written before the caps existed can
 * exceed them — and it degrades to its newest entries rather than exploding
 * the context window.
 */
export function renderWorkingMemory(wm: WorkingMemory): string {
    const sections: string[] = [];

    const goal = clamp(wm.goal, WORKING_MEMORY_LIMITS.goalChars);
    if (goal.length > 0) sections.push(`## Goal\n\n${goal}`);

    const constraints = newest(wm.constraints, WORKING_MEMORY_LIMITS.constraints);
    if (constraints.shown.length > 0) {
        const lines = constraints.shown.map((c) => `- [${c.id}] (${c.origin}) ${clamp(c.text, WORKING_MEMORY_LIMITS.entryChars)}`);
        sections.push(renderSection("Constraints", lines, constraints.omitted, "constraints"));
    }

    const hypotheses = newest(wm.hypotheses, WORKING_MEMORY_LIMITS.hypotheses);
    if (hypotheses.shown.length > 0) {
        const lines = hypotheses.shown.map((h) => `- [${h.id}] ${clamp(h.text, WORKING_MEMORY_LIMITS.entryChars)}`);
        sections.push(renderSection("Hypotheses", lines, hypotheses.omitted, "hypotheses"));
    }

    const findings = newest(flattenFindings(wm.findings), WORKING_MEMORY_LIMITS.findings);
    if (findings.shown.length > 0) {
        const lines = findings.shown.map((f) => `- [${f.id}] (${f.runId}) ${clamp(f.text, WORKING_MEMORY_LIMITS.entryChars)}`);
        sections.push(renderSection("Findings", lines, findings.omitted, "findings"));
    }

    if (sections.length === 0) return "";
    return `# Working Memory\n\n${sections.join("\n\n")}\n`;
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

    function updateSection<S extends Section>(analysisId: string, section: S, value: SectionValue[S]): ResultAsync<void, WorkingMemoryError> {
        return withTransaction(pool, "working-memory.updateSection", (client) =>
            // Serialize concurrent read-modify-write on this analysis — the lock
            // covers the not-yet-existing-row case an `SELECT ... FOR UPDATE`
            // would miss. Released automatically at COMMIT/ROLLBACK. The cap check
            // runs under it too, so two racing adds cannot both slip past a full
            // section.
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
                .andThen((amended) =>
                    // A rejection rides the transaction's ok channel: it is a decision, not a
                    // storage failure. The transaction commits having written nothing, and the
                    // rejection is lifted back into the error channel below.
                    amended.isErr()
                        ? okAsync<Result<void, WorkingMemoryRejection>, DbError>(err(amended.error))
                        : tryMutation("working-memory.updateSection.upsert", () =>
                              client.query(
                                  `INSERT INTO cortex_working_memory (analysis_id, data, updated_at)
               VALUES ($1, $2::jsonb, NOW())
               ON CONFLICT (analysis_id)
               DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
                                  [analysisId, JSON.stringify(amended.value)],
                              ),
                          ).map(() => ok<void, WorkingMemoryRejection>(undefined)),
                ),
        ).andThen((written) => written);
    }

    function render(analysisId: string): ResultAsync<string, DbError> {
        return load(analysisId).map(renderWorkingMemory);
    }

    return { load, updateSection, render };
}
