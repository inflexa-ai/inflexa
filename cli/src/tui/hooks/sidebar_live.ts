import { createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import type { ResultAsync } from "neverthrow";
import type { DataProfileGroup, DataProfilePartition, DataProfileResult } from "@inflexa-ai/harness/contracts/index.js";
import { profileCaveats, profileDimensions, type ProfileDimensionView } from "@inflexa-ai/harness/app/data-profile-view";

import type { DataProfileState, DataProfileView, RunDetail, RunList, RunStatus, RunSummary, StepExecutionStatus } from "../../api/runs.ts";
import type { UsageTotals } from "../../api/usage.ts";
import type { ClientError } from "../../client/api.ts";
import { fetchDataProfile, fetchRun, fetchRuns } from "../../client/runs.ts";
import { getLogger } from "../../lib/log.ts";
import { GLYPHS } from "../../lib/design_system.ts";
import type { ThemeColors } from "../../lib/design_system.ts";
import { formatTokenFigure, formatTokenFigureLabelled } from "../../lib/usage_format.ts";
import type { Workspace } from "../contexts/workspace.ts";
import type { RunStepView } from "../components/run_block.tsx";
import { bootState } from "./boot.ts";
import { chatStatus, type ChatStatus } from "./status.ts";

// The sidebar's live ledger data — the data-profile status and the analysis's newest runs — held
// here (not inside `sidebar.tsx`) so the holder is decoupled from its renderer, the same split as
// `status.ts` / `boot.ts` / `conversation.ts`. The `Sidebar` reads the two snapshots reactively;
// `refreshSidebarData` (re)populates them from the local server; `watchSidebarData` wires the
// lifecycle triggers + the bounded poll from `App`. One chat screen is mounted at a time, so a
// module singleton is correct — and the two snapshots are the only reactive cells (the generation
// token and the interval handle are plain infrastructure, nothing reacts to them).
//
// The server sends no notification of a change, so this reads the run and profile endpoints on
// lifecycle edges and, ONLY while work is active, on a bounded interval.

/**
 * The data-profile section's render input. `not_ready` before the runtime boots (no query is
 * attempted); `unavailable` on a `DbError` (never a crash); `absent` when the ledger row is null
 * (the analysis has not been profiled); `loaded` carries the ledger truth.
 */
export type ProfileSnapshot =
    | { kind: "not_ready" }
    | { kind: "unavailable" }
    | { kind: "absent" }
    | {
          kind: "loaded";
          profile: DataProfileState;
          /**
           * What the profile's own calls consumed, from the local token ledger of the server.
           *
           * Carried on the snapshot rather than read by each surface because the profile's figures
           * have exactly one home and two renderers: the rail's DATA PROFILE section and the details
           * dialog {@link profileDetailLines} composes. The composer is a pure snapshot→lines
           * function, so a figure it is not handed is a figure it cannot show.
           *
           * Absent when the ledger read failed — a missing figure leaves the section rendered without
           * one, and never removes the profile it decorates.
           */
          usage?: UsageTotals;
      };

/**
 * The runs section's render input. `not_ready` before the runtime boots; `unavailable` on a failed
 * read; `loaded` carries the newest runs (possibly empty → the section renders "no runs"). Each run
 * carries its own figure (`usage`), from the same read as the row, so a row and its figure can never
 * come from two different reads of a moving ledger. There is no `absent` kind — an analysis with no
 * runs is a `loaded` empty array, not an absence.
 */
export type RunsSnapshot = { kind: "not_ready" } | { kind: "unavailable" } | { kind: "loaded"; runs: RunSummary[] };

/**
 * Live progress of ONE non-terminal run — the feed for that run's block in the sidebar RUNS section
 * (the run-block vocabulary: the segmented bar, `done/total`, and the ordered steps) and for the
 * activity panel's frontier.
 */
export type ActiveRunProgress = {
    /** The run this progress belongs to — the map key, carried inline so a consumer holding one entry still knows whose it is. */
    runId: string;
    /** The run's human label: its plan title, else its id tail (see {@link runLabelOf}). */
    name: string;
    /** The run's short id tail (see {@link idTail}). */
    tag: string;
    /** When the run started (ISO), for the elapsed readout. */
    startedAt: string;
    /** Completed step count (bar numerator). */
    done: number;
    /** Total step count (bar denominator). */
    total: number;
    /** The run's ordered step views. */
    steps: RunStepView[];
    /**
     * True when this entry was carried forward from a previous refresh because THIS run's step read
     * failed — the run is still active, but what is shown is the last known state rather than the
     * current one.
     *
     * Carried here rather than inferred by a consumer because the carry-forward is invisible from
     * outside: a stale entry and a fresh one are the same shape, so a surface that must mute itself
     * on a blip (the activity panel) has no other way to tell them apart.
     */
    stale: boolean;
};

/**
 * Live progress of the analysis's data profile while it is running — the activity panel's second
 * kind of subject.
 *
 * Carries only what a profile HAS. There is no completion count and no step list because a profile is
 * a single agent loop with no step decomposition, so a `done/total` would have to be invented; and
 * there is no display name because there is one profile per analysis and it is always the same
 * operation, which makes the name a constant belonging to the renderer rather than a fact the ledger
 * supplies.
 */
export type ActiveProfileProgress = {
    /** The analysis whose profile this is — the map-free singleton's identity, carried for symmetry with a run's `runId`. */
    analysisId: string;
    /** When the profile started (ISO), for the elapsed readout. */
    startedAt: string;
    /**
     * The DBOS workflow id the ledger row records — the stream to subscribe to for this profile's
     * activity, or `null` when the row has not recorded one yet.
     *
     * `null` is a normal state, not an error: the body writes its id as its first durable step, so a
     * freshly-claimed row has none, and a claim deliberately clears any previous attempt's id rather
     * than leaving the row pointing at a stream that has already drained.
     */
    workflowId: string | null;
    /**
     * True when this entry was carried forward from a previous refresh because the profile read
     * failed. Same meaning and the same reason as {@link ActiveRunProgress.stale}: the carry-forward
     * is invisible from outside, so a surface that must mute itself on a blip has no other way to
     * tell a stale entry from a fresh one.
     */
    stale: boolean;
};

/**
 * Every active run's progress, keyed by run id. Empty when nothing is active: no runs, all runs
 * terminal, or the runtime not booted.
 *
 * Keyed rather than the single newest-run slot it replaces. The old shape bought its
 * "no run-row/progress mismatch is representable" guarantee from there being exactly one snapshot;
 * this one buys the same guarantee from the KEY — a block renders under the row whose id it is
 * keyed by, so attributing one run's steps to another is still not representable, and a second
 * concurrent run stops being invisible.
 */
export type ActiveRunProgressMap = ReadonlyMap<string, ActiveRunProgress>;

/**
 * One thing the activity panel can be showing. A discriminated union rather than a widened run,
 * because the two kinds genuinely differ in what they have: a profile has no steps and no
 * denominator, and making those optional on one shape would push a guard into every consumer while
 * leaving "a profile with three running steps" representable.
 */
export type PanelSubject = { readonly kind: "run"; readonly run: ActiveRunProgress } | { readonly kind: "profile"; readonly profile: ActiveProfileProgress };

const [profile, setProfile] = createSignal<ProfileSnapshot>({ kind: "not_ready" });
const [runs, setRuns] = createSignal<RunsSnapshot>({ kind: "not_ready" });
// A fresh Map object per publish: Solid's default equality is referential, so mutating one in place
// would update no consumer.
const [activeRun, setActiveRun] = createSignal<ActiveRunProgressMap>(new Map());
// A singleton, not a map: there is exactly one data profile per analysis and the store is scoped to
// the open analysis, so a key would only ever hold one entry.
const [activeProfile, setActiveProfile] = createSignal<ActiveProfileProgress | null>(null);

/** The data-profile snapshot — read in a tracking scope to repaint on refresh. */
export const profileSnapshot = profile;
/** The runs snapshot — read in a tracking scope to repaint on refresh. */
export const runsSnapshot = runs;
/** Every active run's progress keyed by run id (empty when nothing is active) — read in a tracking scope. */
export const activeRunProgress = activeRun;
/** The running data profile's progress, or `null` when none is running — read in a tracking scope. */
export const activeProfileProgress = activeProfile;

/**
 * The live subjects the activity panel can show: every active run, then the running profile.
 *
 * Runs come FIRST, and that ordering is deliberate — it is the one place this module departs from
 * ordering by recency. The two kinds differ in PROVENANCE, not in recency: a profile is auto-triggered
 * when a chat opens on drifted inputs, so it can enter the set without the user having asked for
 * anything, and a newest-first set would routinely let it take the head and displace a run the user
 * launched deliberately. Ordering by kind makes the background thing reachable without ever making it
 * the thing on screen.
 *
 * DERIVED, not written: it holds no state of its own and introduces no second writer, so the refresh
 * remains the single owner of ordering and staleness.
 */
export const activeSubjects = createMemo((): readonly PanelSubject[] => {
    const subjects: PanelSubject[] = [...activeRun().values()].map((run) => ({ kind: "run", run }));
    const profile = activeProfile();
    if (profile) subjects.push({ kind: "profile", profile });
    return subjects;
});

/**
 * Compact relative age of an ISO timestamp (`5m31s`, `8h54m`), or an em dash when absent/unparseable.
 * This is the live-rail vocabulary: the sidebar's fixed-width readouts (the session age, the run rows)
 * answer "how long ago" at a glance, where a full timestamp would overflow the rail and a slightly-stale
 * age still reads right. Durable-record readouts render the opposite — an absolute local time (see
 * {@link absTime}) — because a referenced record (a detail dialog, the rail's completed-profile line)
 * is read long after "5m ago" meant anything.
 *
 * Homed in this hooks module (not `layout/sidebar.tsx`) beside {@link runMark} / {@link shortRunName},
 * the pure sidebar helpers the rail and the runs dialog share, so callers reach them without importing
 * the JSX layout and nothing forces this module to import back into it.
 */
export function relAge(iso: string | null): string {
    // `String.relativeAge` owns the parse-then-age; this wrapper only supplies the rail's em-dash
    // fallback for an absent or unparseable time (the extension stays glyph-free — see string.ext.ts).
    return iso?.relativeAge() ?? GLYPHS.emDash;
}

/**
 * Absolute local timestamp of an ISO string (`toLocaleString`), or an em dash when absent/unparseable.
 * The detail-dialog counterpart to {@link relAge}: the data-profile and runs dialogs render durable,
 * referenced records read long after the fact — when a compact "5m" has lost its anchor — so they pin
 * the full local time. Same em-dash guard shape as {@link relAge}, so an absent/bad time collapses
 * identically across the rail and the dialogs.
 */
export function absTime(iso: string | null): string {
    if (iso === null) return GLYPHS.emDash;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? GLYPHS.emDash : new Date(t).toLocaleString();
}

/**
 * Compact absolute local timestamp (`7/13/26, 10:52 AM`) — the fixed-width rail's absolute
 * vocabulary. A finished run's rail row must carry a workflow name AND an absolute anchor inside
 * ~37 usable cells; {@link absTime}'s seconds-bearing long form pushes that past the rail and
 * soft-wraps mid-token on every row, so the rail trades the seconds for the fit. Detail dialogs
 * (unconstrained width) keep the long form. Same em-dash guard shape as {@link absTime}.
 */
export function absTimeShort(iso: string | null): string {
    if (iso === null) return GLYPHS.emDash;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? GLYPHS.emDash : new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/** How many caveat lines the dialog prints before folding the rest into an `… and N more`. */
const CAVEAT_LINE_CAP = 6;

/** How many of a dimension's example values ride its one line. */
const DIMENSION_SAMPLE_CAP = 3;

/** The dataset's classification — domain, subtype, organism — or `null` when the snapshot carries none. */
function datasetLineOf(r: DataProfileResult): string | null {
    const parts = [r.domain, r.subtype, r.organism?.scientificName].filter((part): part is string => typeof part === "string" && part.length > 0);
    return parts.length === 0 ? null : parts.join(` ${GLYPHS.middot} `);
}

/** The census in one line: kept files in groups, plus the unclassified/quarantined tallies only when nonzero. */
function censusLineOf(p: DataProfilePartition): string {
    const parts = [`${p.keptFiles} file${p.keptFiles === 1 ? "" : "s"} in ${p.groups} group${p.groups === 1 ? "" : "s"}`];
    if (p.unclassifiedFiles > 0) parts.push(`${p.unclassifiedFiles} unclassified`);
    if (p.quarantine.count > 0) parts.push(`${p.quarantine.count} quarantined`);
    return parts.join(` ${GLYPHS.middot} `);
}

/** A group's dominant formats: the top two by file count, then a `+N` for the rest. */
function formatsOf(formats: DataProfileGroup["formats"]): string | null {
    if (formats.length === 0) return null;
    const sorted = [...formats].sort((a, b) => b.count - a.count);
    const names = sorted
        .slice(0, 2)
        .map((f) => f.format)
        .join("/");
    return sorted.length > 2 ? `${names} +${sorted.length - 2}` : names;
}

/**
 * One group's line: identity (`count × memberRepresents`), scale (compact bytes), dominant formats,
 * and the display pattern as the shape of the members. The swept residue is marked with the warning
 * glyph — it is what no operation claimed, not a declared grouping.
 */
function groupLineOf(g: DataProfileGroup): string {
    const facts = [`${g.count} ${GLYPHS.multiply} ${g.memberRepresents}`, g.totalBytes.formatBytes(), formatsOf(g.formats), g.displayPattern].filter(
        (fact): fact is string => fact !== null && fact.length > 0,
    );
    return `  ${g.unclassified === true ? `${GLYPHS.warning} ` : ""}${g.name} ${GLYPHS.emDash} ${facts.join(` ${GLYPHS.middot} `)}`;
}

/** Largest first — bytes are the honest scale — with the swept residue always last. */
function orderedGroups(groups: DataProfileGroup[]): DataProfileGroup[] {
    return [...groups].sort((a, b) => Number(a.unclassified === true) - Number(b.unclassified === true) || b.totalBytes - a.totalBytes);
}

/**
 * One dimension's line: label, every reported cardinality (observations that disagree both stand —
 * the record declares no canonical count), and a bounded sample of values.
 */
function dimensionLineOf(d: ProfileDimensionView): string {
    const facts: string[] = [];
    if (d.cardinalities.length > 0) {
        facts.push(`${d.cardinalities.join("/")} value${d.cardinalities.length === 1 && d.cardinalities[0] === 1 ? "" : "s"}`);
    }
    if (d.exampleValues.length > 0) {
        const shown = d.exampleValues.slice(0, DIMENSION_SAMPLE_CAP);
        const truncated = d.exampleValues.length > shown.length || d.cardinalities.some((c) => c > shown.length);
        facts.push(shown.join(", ") + (truncated ? `, ${GLYPHS.ellipsis}` : ""));
    }
    return facts.length === 0 ? `  ${d.label}` : `  ${d.label} ${GLYPHS.emDash} ${facts.join(` ${GLYPHS.middot} `)}`;
}

/**
 * Compose the DATA PROFILE details view's lines from a {@link ProfileSnapshot}. Pure
 * (snapshot → string[]) so every kind is unit-testable: the degraded kinds each yield one placeholder
 * line, and `loaded` yields the ledger truth, top-down — a status line, the started/completed absolute
 * local times plus the run duration (or the elapsed-at-open age while a profile is still running), the
 * error (on failure), then what the dataset IS (`dataset` classification + `census` partition line),
 * the summary prose, a groups section (or the legacy per-file `path — description` list), a dimensions
 * section, bounded caveats, and the seed-input count. Rendered verbatim by `ResultsDialog` (the design
 * gallery drives it over a mock).
 */
export function profileDetailLines(snap: ProfileSnapshot): string[] {
    switch (snap.kind) {
        case "not_ready":
            return ["runtime not ready"];
        case "absent":
            return ["not profiled yet"];
        case "unavailable":
            return ["profile status unavailable"];
        case "loaded": {
            const p = snap.profile;
            const lines: string[] = [`status: ${p.status}`];
            if (p.startedAt) lines.push(`started ${absTime(p.startedAt)}`);
            if (p.completedAt) lines.push(`completed ${absTime(p.completedAt)}`);
            // A finished profile (completed OR failed — the ledger stamps `completedAt` on both) shows
            // how long it took; a still-running profile has no end yet, so the dialog — a point-in-time
            // snapshot — shows the age elapsed at the moment it was opened instead of a duration.
            const startedMs = p.startedAt ? Date.parse(p.startedAt) : NaN;
            const completedMs = p.completedAt ? Date.parse(p.completedAt) : NaN;
            if (!Number.isNaN(startedMs) && !Number.isNaN(completedMs)) {
                lines.push(`duration ${Date.formatDuration(completedMs - startedMs)}`);
            } else if (!Number.isNaN(startedMs)) {
                lines.push(`elapsed ${Date.relativeAge(startedMs)}`);
            }
            // One more property line, in the same `label value` vocabulary as the timings above, and in
            // the same notation every other surface prints a figure in. It belongs HERE and nowhere
            // else in the dialog stack: the profile's calls carry no thread, so they are absent from
            // every session figure by construction.
            //
            // Omitted when nothing was reported, exactly as `started`/`completed` are omitted when the
            // ledger holds no stamp — an unconditional line would have to print a zero, which asserts
            // a measurement the ledger does not hold.
            //
            // The LONG form, unlike the compact figure the rail's DATA PROFILE section carries for the
            // same profile: this is a `label value` property line in a full-width dialog being read
            // deliberately, where the rail's is a decoration scanned in a 37-cell column.
            const usage = snap.usage ? formatTokenFigureLabelled(snap.usage) : "";
            if (usage !== "") lines.push(`usage ${usage}`);
            if (p.status === "failed" && p.error) {
                lines.push("");
                for (const line of p.error.split("\n")) lines.push(line);
            }
            if (p.result) {
                const r = p.result;
                const dataset = datasetLineOf(r);
                const census = r.partition ? censusLineOf(r.partition) : null;
                if (dataset !== null || census !== null) {
                    lines.push("");
                    if (dataset !== null) lines.push(`dataset ${dataset}`);
                    if (census !== null) lines.push(`census ${census}`);
                }
                if (r.summary.trim().length > 0) {
                    lines.push("");
                    for (const line of r.summary.split("\n")) lines.push(line);
                }
                const groups = r.groups ?? [];
                const files = r.files ?? [];
                if (groups.length > 0) {
                    lines.push("");
                    lines.push(`groups (${groups.length}):`);
                    for (const g of orderedGroups(groups)) lines.push(groupLineOf(g));
                } else if (files.length > 0) {
                    lines.push("");
                    lines.push(`files (${files.length}):`);
                    for (const f of files) lines.push(`  ${f.path} ${GLYPHS.emDash} ${f.description}`);
                }
                const dimensions = profileDimensions(r);
                if (dimensions.length > 0) {
                    lines.push("");
                    lines.push(`dimensions (${dimensions.length}):`);
                    for (const d of dimensions) lines.push(dimensionLineOf(d));
                }
                const caveats = profileCaveats(r);
                if (caveats.length > 0) {
                    lines.push("");
                    lines.push(`caveats (${caveats.length}):`);
                    for (const caveat of caveats.slice(0, CAVEAT_LINE_CAP)) lines.push(`  ${GLYPHS.warning} ${caveat}`);
                    if (caveats.length > CAVEAT_LINE_CAP) lines.push(`  ${GLYPHS.ellipsis} and ${caveats.length - CAVEAT_LINE_CAP} more`);
                }
            }
            // `seedInputFileIds` is the desired-parity set; fall back to the count the profile itself
            // covered when the seed set was not recorded (older rows) — the input signature — else 0.
            const seedCount = p.seedInputFileIds?.length ?? p.result?.inputSignature?.count ?? 0;
            lines.push("");
            lines.push(`${seedCount} seed input${seedCount === 1 ? "" : "s"}`);
            return lines;
        }
        default: {
            const _exhaustive: never = snap;
            return [String(_exhaustive)];
        }
    }
}

/**
 * The themed glyph + color role for a run's status. The single exhaustive `runMark`,
 * shared by the sidebar rail and the runs dialog (both need the identical status→glyph/role mapping).
 * running=warn, completed=success, failed/canceled=error, `suspended_insufficient_funds`=warn,
 * `partial`=muted. A `never`-typed default breaks the build if the harness enum grows, forcing a new
 * status to be classified rather than silently mis-toned.
 *
 * Homed in this hooks module (not `layout/sidebar.tsx`) beside the other pure, non-JSX sidebar helpers
 * so the runs dialog can share it without importing the JSX layout module.
 */
export function runMark(status: RunStatus): { glyph: string; role: keyof ThemeColors } {
    switch (status) {
        case "running":
            return { glyph: GLYPHS.circleHalf, role: "warning" };
        case "completed":
            return { glyph: GLYPHS.check, role: "success" };
        case "failed":
        case "canceled":
            return { glyph: GLYPHS.cross, role: "error" };
        case "suspended_insufficient_funds":
            // Actionable, not just terminal: the run is paused awaiting funds/resume, so it warrants
            // the "needs attention" warn tone rather than the muted grey of `partial` (which is simply
            // a finished-with-gaps end state the user cannot act on).
            return { glyph: GLYPHS.circle, role: "warning" };
        case "partial":
            return { glyph: GLYPHS.circle, role: "fgMuted" };
        default: {
            const _exhaustive: never = status;
            return { glyph: GLYPHS.circle, role: "fgMuted" };
        }
    }
}

/** A run's short label: the workflow name, else the run id tail. */
export function shortRunName(run: Pick<RunSummary, "workflowName" | "runId">): string {
    return run.workflowName.length > 0 ? run.workflowName : idTail(run.runId);
}

/**
 * A run's display label: its plan's title when there is one, else the run's id tail.
 *
 * The fallback deliberately skips {@link shortRunName}. That returns `workflowName`, which is
 * `"executeAnalysis"` on every row in the ledger and therefore distinguishes nothing — falling back
 * to it would label every unresolvable run identically, which is strictly worse than the id tail
 * the rail has always used for exactly this reason. The readable 3–8-word name the planner wrote
 * lives on the plan, and the server sends it as `planTitle` when there is one.
 */
export function runLabelOf(run: Pick<RunSummary, "planTitle" | "runId">): string {
    return run.planTitle ?? idTail(run.runId);
}

/** A short, human-scannable tail of a uuid (dashes stripped) — the run tag the run-detail dialog + sidebar progress embed show. */
export function idTail(id: string): string {
    return id.replace(/-/g, "").slice(-6);
}

/**
 * The short handle of a session id — `S` plus the first four hex digits of the thread id.
 *
 * It is a LANDMARK, not a discriminator, and the head is why: a thread id is a uuid v7, whose leading
 * digits are the high bits of the mint time, so sessions started within weeks of each other carry the
 * same four. What the handle buys is that one session reads the same on the SESSION chip and on a
 * picker row, so a reader matches the two at a glance. Telling two rows apart is the full id's job,
 * which is why the picker's detail line carries it.
 *
 * Homed beside the other rail formatters rather than in the rail itself, because both surfaces print
 * it. Two surfaces spelling one handle two ways is a difference a reader tries to interpret.
 */
export function shortSessionId(threadId: string): string {
    return `S${GLYPHS.middot}${threadId.replace(/-/g, "").slice(0, 4)}`;
}

/**
 * Map a harness step-execution status onto the design-system run-step state. Pure and
 * exhaustive over {@link StepExecutionStatus} — a `never`-typed default breaks the build if the
 * harness enum grows, so a new status is classified honestly rather than silently mis-bucketed.
 *
 * The five buckets are `done | running | failed | queued | skipped`; the honest mapping of the seven
 * harness statuses:
 *  - `pending` → `queued` — has not run and is still going to.
 *  - `skipped` → `skipped` — never ran and never will, because an upstream step failed or blocked.
 *    Kept distinct from `queued`: folding them made a doomed dependent read as work still ahead,
 *    which is the opposite of what it is. Neither is a success or an error, so both stay muted.
 *  - `running` → `running`, `completed` → `done`, `failed` → `failed` — direct.
 *  - `canceled` → `failed` — a fail-fast sibling stopped mid-flight; a non-success terminal, shown
 *    error-toned to match the sidebar's run-level `canceled`.
 *  - `blocked` → `failed` — an agent-declared blocker; `executeAnalysis` treats it as a failure
 *    (`step_blocked`), so the error tone is the honest signal.
 *
 * Homed here beside {@link runMark} / {@link shortRunName} (the pure, non-JSX run helpers) so both the
 * runs dialog and the sidebar-live refresh loop share the identical status→state mapping without one
 * reaching into the other.
 */
export function stepStateOf(status: StepExecutionStatus): RunStepView["state"] {
    switch (status) {
        case "pending":
            return "queued";
        case "skipped":
            return "skipped";
        case "running":
            return "running";
        case "completed":
            return "done";
        case "failed":
        case "canceled":
        case "blocked":
            return "failed";
        default: {
            const _exhaustive: never = status;
            // Unreachable: the `never` assignment above proves every status is handled. The cast only
            // satisfies the return type on this dead branch — if it ever runs, the harness added a
            // status the switch does not cover, and we surface its raw string rather than crash.
            return String(_exhaustive) as RunStepView["state"];
        }
    }
}

/** How many run rows a refresh pulls. The sidebar renders the newest few; the store holds the head. */
const RUNS_LIMIT = 10;

/** The bounded poll cadence while work is active. Idle sidebars issue zero queries. */
const POLL_INTERVAL_MS = 5_000;

/**
 * How long a guarded refresh may hold the in-flight guard before the next trigger takes it away.
 *
 * A MULTIPLE of the poll cadence rather than its own constant: the bound is only ever meaningful
 * relative to that cadence — long enough that a merely slow refresh still finishes and writes its
 * snapshots, short enough that a wedged one costs a small number of ticks — and two independent
 * constants would let tuning either one silently invert that relationship. Three ticks is the
 * smallest multiple that reads as "comfortably longer than one poll" rather than "a poll that ran
 * late".
 */
const REFRESH_BOUND_MS = POLL_INTERVAL_MS * 3;

/**
 * Terminal run statuses — a run that reached a final state polling cannot advance. A NON-terminal run
 * (`running`, or a fund-suspended run awaiting a resume) can still change its ledger row under us,
 * which is exactly what arms the poll. Declared exhaustively over {@link RunStatus} (a full record,
 * not a set literal) so adding a status to the harness enum is a compile error here until it is
 * classified — the arming rule must never silently mis-treat a new status as terminal.
 *
 * Trade-off: a genuinely wedged non-terminal run keeps the 5s poll alive. Accepted
 * — it is bounded, cheap (≤10 rows), and visible; the alternative (guessing wedged-ness) is worse.
 */
/** Whether a run status means the run is finished — i.e. nothing is still writing to its workspace. */
export const RUN_STATUS_TERMINAL: Record<RunStatus, boolean> = {
    running: false,
    completed: true,
    failed: true,
    partial: true,
    canceled: true,
    suspended_insufficient_funds: false,
};

/**
 * Whether the snapshots should keep the bounded poll armed: a pending/running data profile, any run
 * in a non-terminal status, OR an `unavailable` snapshot. This is the sole gate on the poll — pure so
 * the arming decision is unit-testable without a reactive root.
 *
 * `unavailable` arms because it is the failed-read degrade: a transient blip mid-profile/mid-run
 * would otherwise tear the poll down on an idle screen and nothing would ever re-read to recover, so
 * the section would stay stuck at "unavailable" until the next lifecycle edge. Re-arming lets the
 * SAME cheap 5s poll self-heal the moment the read succeeds again. A persistent outage keeps that one
 * failing read alive — accepted, exactly like a genuinely wedged non-terminal run: it is
 * bounded, cheap (≤10 rows), and the alternative (guessing transient-vs-persistent) is worse.
 */
export function hasActiveWork(profileSnap: ProfileSnapshot, runsSnap: RunsSnapshot): boolean {
    const anyUnavailable = profileSnap.kind === "unavailable" || runsSnap.kind === "unavailable";
    const profileActive = profileSnap.kind === "loaded" && (profileSnap.profile.status === "pending" || profileSnap.profile.status === "running");
    const runsActive = runsSnap.kind === "loaded" && runsSnap.runs.some((r) => !RUN_STATUS_TERMINAL[r.status]);
    return anyUnavailable || profileActive || runsActive;
}

/**
 * The reads of {@link refreshSidebarData}, injectable so the refresh is unit-testable offline (no
 * server). Production callers omit the argument and get the boot phase and the run and profile
 * endpoints; tests pass fakes whose reads resolve on the test's schedule, so interleaving two rapid
 * refreshes (the staleness guard) and the `error → unavailable` / `null → absent` ladder are
 * exercisable without a server.
 */
export type RefreshOpts = {
    /** Whether the runtime of the server is ready. Real: the boot phase is `ready`. */
    readonly ready: () => boolean;
    /** Read the data profile. Real: `GET {A}/data-profile`. */
    readonly loadProfile: (analysisId: string) => ResultAsync<DataProfileView, ClientError>;
    /** Read the analysis's newest runs (newest-first, capped). Real: `GET {A}/runs` with `perPage` {@link RUNS_LIMIT}. */
    readonly loadRuns: (analysisId: string) => ResultAsync<RunSummary[], ClientError>;
    /**
     * Read EVERY non-terminal run, uncapped. Real: `GET {A}/runs?active=true`.
     *
     * Separate from {@link loadRuns} because the two answer different questions and only one of them
     * may be windowed. `loadRuns` answers "the newest N" — right for a listing. Live work cannot be
     * windowed at all: ordering by start time and capping drops the OLDEST running run first, which
     * is the long analysis this whole surface exists to keep visible. Ten short runs starting after
     * it would push it off the list, taking its rail block, its panel entry, and its completion
     * notice with it.
     */
    readonly loadActiveRuns: (analysisId: string) => ResultAsync<RunSummary[], ClientError>;
    /**
     * Read one run with its steps, the plan names of the steps, and the usage of each step — fired once
     * per NON-TERMINAL run, never for a terminal one. Real: `GET {A}/run/:runId`.
     */
    readonly loadRun: (analysisId: string, runId: string) => ResultAsync<RunDetail, ClientError>;
};

/**
 * All the active runs in one read. The server caps a page at 200, and the live concurrency of an
 * analysis is far below that.
 */
const ACTIVE_RUNS_PAGE = 200;

const DEFAULT_REFRESH_OPTS: RefreshOpts = {
    ready: () => bootState().phase === "ready",
    loadProfile: (analysisId) => fetchDataProfile(analysisId),
    loadRuns: (analysisId) => fetchRuns(analysisId, { perPage: RUNS_LIMIT }).map((list: RunList) => list.runs),
    loadActiveRuns: (analysisId) => fetchRuns(analysisId, { active: true, perPage: ACTIVE_RUNS_PAGE }).map((list: RunList) => list.runs),
    loadRun: (analysisId, runId) => fetchRun(analysisId, runId),
};

// Monotonic token identifying the newest refresh. Two rapid analysis swaps interleave their async
// reads, and the older refresh can resolve LAST; without this it would clobber the newer
// snapshots. Each read's post-await re-check drops a superseded refresh — the last refresh STARTED
// wins regardless of which finishes last. Module-private: only refreshSidebarData touches it.
// Mirrors `loadGeneration` in `conversation.ts`.
let refreshGeneration = 0;

/**
 * Reset BOTH snapshots to `not_ready` together (the torn-pair guarantee), clear the active-run progress
 * snapshot, and invalidate any in-flight refresh. Used at an analysis swap so the previous analysis's DATA
 * PROFILE / RUNS / progress embed never render (nor get dialog-snapshotted) during the swap's
 * one-round-trip refresh window, and by the test reset hook.
 */
function resetSnapshots(): void {
    refreshGeneration += 1;
    setProfile({ kind: "not_ready" });
    setRuns({ kind: "not_ready" });
    setActiveRun(new Map());
    setActiveProfile(null);
}

/**
 * Repopulate both snapshots (and the active-run progress map) for `analysisId` from the local server.
 * No-ops to `not_ready` (both snapshots) and clears the progress map when the runtime is not ready —
 * the sidebar renders a muted placeholder and no request goes out (the no-op guard).
 *
 * The profile read `.match`es INDEPENDENTLY of the run reads: a failed profile read degrades the
 * profile section to `unavailable` while the runs section still loads, and vice versa — the two
 * sections never share a failure. A never-profiled analysis becomes `absent`, and every write is a
 * fresh object so Solid always reconciles.
 *
 * The RUNS section is the merge of an uncapped non-terminal read (what is live) and a newest-N window
 * (what to list); either failing degrades to the other, and only both failing yields `unavailable`.
 * Every non-terminal run in the merge then gets a run read and publishes an {@link activeRunProgress}
 * entry keyed by its run id — so a terminal-only analysis fires NO run read and stays at zero step
 * reads. One run's failed read carries that run's previous entry forward, marked `stale`, and cannot
 * affect any other run's entry.
 *
 * The figures ride the same reads: the profile's totals on the profile, each listed run's totals on
 * its row, and each active run's step totals on its steps. A figure the server could not read is
 * absent, and the entity it decorates still renders.
 *
 * Staleness: the refresh claims a {@link refreshGeneration} token at entry and re-checks it after
 * every await; a refresh superseded by a newer swap silently drops rather than writing stale rows.
 */
export async function refreshSidebarData(analysisId: string, opts: RefreshOpts = DEFAULT_REFRESH_OPTS): Promise<void> {
    // Bump BEFORE the ready guard so even the not_ready path invalidates any in-flight older refresh
    // — a swap to an unbooted scope must not later be overwritten by a slow read from the prior scope.
    const myRefresh = ++refreshGeneration;
    if (!opts.ready()) {
        setProfile({ kind: "not_ready" });
        setRuns({ kind: "not_ready" });
        setActiveRun(new Map());
        setActiveProfile(null);
        return;
    }

    // Three awaited-inline reads, kept serial where the fan-out below is not: these are O(1) in the
    // run count, so the round trips saved by racing them do not scale, and re-checking the generation
    // token after EACH await lets a superseded refresh drop at the first opportunity instead of only
    // after the slowest of the three. Each `.match`es INDEPENDENTLY, so a profile read failure
    // degrades the profile section alone.
    const profileRes = await opts.loadProfile(analysisId);
    if (myRefresh !== refreshGeneration) return;
    const runsRes = await opts.loadRuns(analysisId);
    if (myRefresh !== refreshGeneration) return;
    const activeRes = await opts.loadActiveRuns(analysisId);
    if (myRefresh !== refreshGeneration) return;

    profileRes.match(
        (view) => {
            if (view.status === null) {
                setProfile({ kind: "absent" });
                return;
            }
            // The figure rides beside the row, never inside it: the row is the ledger truth, the figure a
            // decoration that an absent read leaves off.
            const { usage, ...profile } = view;
            setProfile(usage === undefined ? { kind: "loaded", profile } : { kind: "loaded", profile, usage });
        },
        () => setProfile({ kind: "unavailable" }),
    );

    // The profile's panel-subject entry, published from the SAME read the section above uses — one
    // reader, one generation token, no second staleness rule.
    //
    // Only a `running` profile is published. A `pending` row carries no `startedAt` (the ledger writes
    // it on the transitions INTO `running`) and no workflow id, so a pending entry would be a name
    // beside a blank elapsed and a blank activity — and `pending` means seeded-and-queued, while this
    // entry describes work in flight. The poll's arming condition still counts pending as active work,
    // which is right: that decides whether to keep looking, not whether there is anything to show.
    //
    // The `startedAt` conjunct is TYPE NARROWING, not a second rule: the ledger's `startedAt` is
    // nullable while the entry's is not, and every claim into `running` stamps it in the same UPDATE.
    // So a `running` row without one is a state the ledger does not produce, and this cannot silently
    // hide a live profile — which is also why it is left unpinned by the tests rather than encoded as
    // behaviour the ledger would have to keep honouring.
    profileRes.match(
        (view) =>
            setActiveProfile(
                view.status === "running" && view.startedAt !== null
                    ? { analysisId, startedAt: view.startedAt, workflowId: view.workflowId, stale: false }
                    : null,
            ),
        () =>
            // A read failure carries the previous entry forward rather than dropping it. Without this a
            // transient blip would remove the panel's profile entry entirely — the snapshot collapses to
            // a single `unavailable` on any error — so the subject would vanish and return, which reads
            // as the profile having finished and a new one starting. Re-stamped only on the fresh→stale
            // edge; an already-stale entry is carried by IDENTITY so consumers memoized on it do not
            // re-fire for a value that cannot have changed.
            setActiveProfile((prev) => (prev === null || prev.stale ? prev : { ...prev, stale: true })),
    );

    // The two run reads answer different questions, and the section survives EITHER failing.
    //   - the uncapped non-terminal read is the AUTHORITY on what is live;
    //   - the newest-N window decides only what the RUNS section LISTS.
    // Merged active-first, then the window's rows minus anything already present, so a long-running
    // analysis that has fallen off the window is still both listed and tracked. Each read degrades to
    // the other's view rather than blanking the section — a read that adds coverage must never take
    // coverage away, and that has to hold in BOTH directions: dropping a successful active read
    // because the mere listing blipped would cost the rail block, the panel entry, AND the completion
    // announcement (which returns early unless the snapshot is `loaded`) for a run known to be live.
    // Only when BOTH reads fail is there nothing to show.
    const live = activeRes.unwrapOr(null);
    const listed = runsRes.unwrapOr(null);
    if (live === null && listed === null) {
        // A failed runs read is a transient degrade that itself re-arms the poll (`hasActiveWork`). Keep
        // any existing progress entries so a blip does not flash the whole section away and back.
        setRuns({ kind: "unavailable" });
        return;
    }
    const seen = new Set((live ?? []).map((r) => r.runId));
    const merged = [...(live ?? []), ...(listed ?? []).filter((r) => !seen.has(r.runId))];
    setRuns({ kind: "loaded", runs: merged });

    // EVERY non-terminal run publishes a progress entry, keyed by its run id. A terminal run (or no
    // runs at all) publishes none, and only a non-terminal run fires a run read — so an idle
    // analysis still issues zero step reads, the property the poll's arming condition depends on.
    const active = merged.filter((r) => !RUN_STATUS_TERMINAL[r.status]);
    if (active.length === 0) {
        setActiveRun(new Map());
        return;
    }

    // CONCURRENT, not sequential. Each run's read is independent of every other's, and the set is
    // bounded by the live concurrency of the analysis. `.match` rather than handing the `ResultAsync`
    // straight to `Promise.all`: it consumes the Result into a plain promise, which is what keeps the
    // `must-use-result` lint satisfied.
    //
    // A run whose read blipped resolves to `null` and is simply absent from `fresh`; the assembly
    // below carries its previous entry forward, so the bounded poll self-heals without blinking a
    // genuinely running run away. Keying by run id is what makes that safe: one run's steps can never
    // show under another's row.
    const runReads = await Promise.all(
        active.map((run) =>
            opts.loadRun(analysisId, run.runId).match(
                (detail) => detail,
                () => null,
            ),
        ),
    );
    if (myRefresh !== refreshGeneration) return;

    // Built here rather than inside the setter because a run whose read blipped must be carried
    // forward from the PREVIOUS map — and reading that signal here would both track reactivity
    // nothing wants and pin the value to loop-entry rather than write time.
    const fresh = new Map<string, ActiveRunProgress>();
    for (const detail of runReads) {
        if (!detail) continue;
        const steps: RunStepView[] = detail.steps.map((step) => {
            // Written once, here, rather than handed down as quantities: the block renders what it is
            // given, and `""` (nothing reported) collapses to an absent field so a step whose
            // providers reported nothing carries no figure instead of a zeroed one.
            const figure = formatTokenFigure(step.usage ?? {});
            return {
                // The plan's human phrase for the step, falling back to the slug the ledger keys on. This
                // is what answers "what is being worked on" in words: the step row itself carries only
                // `T{track}S{step}`.
                label: step.name ?? step.stepId,
                state: stepStateOf(step.status),
                startedAt: step.startedAt,
                agent: step.agentId,
                blockedReason: step.blockedReason,
                attempts: step.attempts,
                usageFigure: figure === "" ? undefined : figure,
            };
        });
        fresh.set(detail.runId, {
            runId: detail.runId,
            name: runLabelOf(detail),
            tag: idTail(detail.runId),
            startedAt: detail.startedAt,
            done: steps.filter((s) => s.state === "done").length,
            total: steps.length,
            steps,
            stale: false,
        });
    }

    setActiveRun((prev) => {
        // Assembled in `active` order — the runs read's newest-first order — NOT in the order the
        // reads happened to succeed. Map iteration order is what every consumer reads as run order:
        // the rail's blocks, and the panel's position indicator and implicit focus. Appending
        // carried-forward entries instead would let a transient blip on one run reorder the whole
        // set, silently swapping which run the panel shows.
        const next = new Map<string, ActiveRunProgress>();
        for (const run of active) {
            const read = fresh.get(run.runId);
            if (read) {
                next.set(run.runId, read);
                continue;
            }
            const kept = prev.get(run.runId);
            if (!kept) continue;
            // Re-stamped on the FRESH → STALE edge only. The entry's CONTENT is the last known state,
            // but its freshness is a property of THIS refresh, so a run that read cleanly last tick
            // must stop advertising itself as fresh. An already-stale entry is carried by IDENTITY
            // instead: it asserts the same fact, and minting an equal-but-new object would re-fire
            // every consumer memoized on it for a value that cannot have changed.
            next.set(run.runId, kept.stale ? kept : { ...kept, stale: true });
        }
        return next;
    });
}

/**
 * Injectable edges so {@link watchSidebarData}'s trigger + arming logic is unit-testable offline —
 * mirrors the seam pattern the boot store (`BootDriver`) and send path use. Production callers omit
 * the argument. `arm` wraps `setInterval`/`clearInterval` into a single arm→disarm closure so a test
 * can capture the tick callback and drive it deterministically (no fake global clock), and assert the
 * disarm fires when work goes terminal or the watcher tears down.
 */
export type WatchSeams = {
    /** Repopulate the snapshots for an analysis. Real: {@link refreshSidebarData}. */
    readonly refresh: (analysisId: string) => Promise<void>;
    /** Arm a repeating timer; returns its disarm. Real: wraps `setInterval`/`clearInterval`. */
    readonly arm: (fn: () => void, ms: number) => () => void;
};

const realWatchSeams: WatchSeams = {
    refresh: refreshSidebarData,
    arm: (fn, ms) => {
        const handle = setInterval(fn, ms);
        return () => clearInterval(handle);
    },
};

/**
 * Wire the sidebar's live-data lifecycle. Call once from `App` (inside its reactive root). Three
 * triggers, each an effect over the module's reactive sources:
 *
 *  1. **ready / analysis swap** — refresh when boot reaches `ready` and an analysis is open, and
 *     again whenever the open analysis changes.
 *  2. **turn completion** — refresh on the `busy → idle` down-edge of {@link chatStatus}, so a run or
 *     profile the agent launched during the turn is reflected without user action. `refresh` itself
 *     no-ops when the runtime is not ready, so this needs no boot guard of its own.
 *  3. **bounded poll** — an interval armed ONLY while {@link hasActiveWork} holds for the open
 *     analysis, torn down the moment work goes terminal (or the analysis swaps, or the watcher
 *     unmounts). The arming key is a MEMO (`active ? analysisId : null`) so the interval is not
 *     re-armed on every snapshot identity change (each refresh mints fresh snapshot objects) — it
 *     re-arms only when the arm/disarm decision or the analysis actually changes, keeping the 5s
 *     cadence steady and guaranteeing an idle sidebar issues zero queries.
 *
 * The poll ticks share one in-flight guard so they never overlap themselves, and that guard is bounded
 * by {@link REFRESH_BOUND_MS} so a refresh that cannot finish can never disable the ones after it.
 *
 * The server sends no event when a run changes, thus a run that a different client starts shows at
 * the next of these edges. A caller that learns of a new run, for example from a run card of the
 * turn, calls {@link refreshSidebarData} itself.
 */
export function watchSidebarData(workspace: Workspace, seams: WatchSeams = realWatchSeams): void {
    // Trigger 1 — ready + analysis (and analysis swap). On a genuine swap the two snapshots still hold
    // the PREVIOUS analysis's ledger data, and the refresh below is a full ledger round-trip — so
    // without a synchronous reset the old analysis's DATA PROFILE / RUNS (and any dialog snapshot of
    // them) would render for that whole window. Reset both to not_ready together BEFORE the refresh; the
    // refresh then repopulates for the new analysis (its generation token drops any prior in-flight read).
    let prevAnalysisId: string | null = null;
    createEffect(() => {
        const phase = bootState().phase;
        const analysisId = workspace.analysis?.id ?? null;
        if (phase !== "ready" || analysisId === null) {
            prevAnalysisId = analysisId;
            return;
        }
        // Reset only on a genuine swap between two open analyses — the first ready edge finds the
        // snapshots already not_ready, so a reset there would be a redundant same-value write.
        if (prevAnalysisId !== null && prevAnalysisId !== analysisId) resetSnapshots();
        prevAnalysisId = analysisId;
        void seams.refresh(analysisId);
    });

    // Trigger 2 — the busy→idle down-edge. `prev` is closure-local per watcher invocation; seeded to
    // the current status so the effect's initial (synchronous) run never fires a false edge.
    let prev: ChatStatus = chatStatus();
    createEffect(() => {
        const status = chatStatus();
        const analysisId = workspace.analysis?.id;
        if (prev === "busy" && status === "idle" && analysisId) void seams.refresh(analysisId);
        prev = status;
    });

    // Trigger 3 — the bounded poll. `disarm` is the live interval's teardown (null when idle).
    let disarm: (() => void) | null = null;
    const teardown = (): void => {
        if (disarm) {
            disarm();
            disarm = null;
        }
    };
    const armKey = createMemo<string | null>(() => {
        const active = hasActiveWork(profileSnapshot(), runsSnapshot());
        const analysisId = workspace.analysis?.id;
        return active && analysisId ? analysisId : null;
    });
    // A tick fired while the previous refresh is still awaiting the server is DROPPED, not queued.
    // `refreshSidebarData` claims the generation token at entry, so a newer refresh CANCELS an older
    // one — without this guard, reads slower than the interval would leave every tick superseded by
    // the next and the store would never receive a write at all. That failure is self-sustaining: an
    // `unavailable` snapshot is itself an arming condition (`hasActiveWork`), so a struggling server
    // would be re-queried every 5s behind a permanently frozen section. Skipping degrades cadence
    // instead. Only the POLL skips: lifecycle edges carry new information and must supersede.
    //
    // The claim is a TIMESTAMPED token, not a boolean, because the guard must be bounded: a read that
    // never settles would hold a boolean for the process lifetime, and that one stall would silently
    // freeze every live surface at its last value — with no error anywhere, and indistinguishable from
    // a run that stopped progressing.
    let inFlight: { readonly startedAt: number } | null = null;

    /**
     * Run one refresh under the in-flight guard, abandoning a claim that has outlived
     * {@link REFRESH_BOUND_MS}.
     *
     * Abandonment is resolved HERE, when the next trigger asks for the guard, rather than by a timer
     * armed alongside each refresh: the guard only matters when something wants it, so the moment of
     * asking is the moment the answer is needed, and there is no per-refresh handle to cancel on
     * teardown. Nothing is published on abandonment — the previous snapshots stand, and the abandoned
     * refresh, if it ever settles, is dropped by the generation token the replacement has already
     * bumped.
     */
    function guardedRefresh(analysisId: string): void {
        const at = Date.now();
        const held = inFlight;
        if (held !== null) {
            if (at - held.startedAt < REFRESH_BOUND_MS) return;
            getLogger("chat").warn(
                { analysisId, elapsedMs: at - held.startedAt, boundMs: REFRESH_BOUND_MS },
                "sidebar refresh exceeded its bound; abandoning it so live surfaces resume updating",
            );
        }
        const claim = { startedAt: at };
        inFlight = claim;
        // Cleared by IDENTITY: an abandoned refresh can still settle long after its replacement
        // claimed the guard, and a bare `inFlight = null` there would release a claim it does not own.
        void seams.refresh(analysisId).finally(() => {
            if (inFlight === claim) inFlight = null;
        });
    }

    createEffect(() => {
        const key = armKey();
        teardown();
        if (!key) return;
        disarm = seams.arm(() => guardedRefresh(key), POLL_INTERVAL_MS);
    });
    onCleanup(teardown);
}

/**
 * Test hook: reset both snapshots to `not_ready`, clear the active-run progress snapshot, and invalidate any
 * in-flight refresh. Test-only — mirrors `__resetBootForTest`.
 */
export function __resetSidebarLiveForTest(): void {
    resetSnapshots();
}
