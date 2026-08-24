/**
 * inspectDataProfile — read the analysis's data profile.
 *
 * Dependency-bearing: the database `Pool` is captured by the factory (see the
 * harness-durable-runtime spec). The analysis id is read from the request-scoped
 * `Session`, not an ambient request context — the same shape as `inspectRun`.
 *
 * **There is no data-profile file.** The profiler's `runs/data-profile/` scratch tree
 * is deleted when profiling completes; the profile's only durable home is the
 * `cortex_analysis_state` row this tool reads. That makes this the single authoritative
 * source for dataset facts — the identity fields, the resolved groups with their slots,
 * the dimensions with their observations, and the partition census — and it is why the
 * record is served in full rather than summarized: an agent that cannot pull a fact here
 * has no fallback but to re-derive it from the raw bytes.
 *
 * Bounded by construction. Like `inspect_run`, the member scope is explicitly paged and
 * always reports `total` and `hasMore`: an elided tail is a fact the model can see and
 * act on, never a silent truncation. The annotated-member count and the dataset's file
 * count are reported as two distinct figures, because a profile annotating eight members
 * of several thousand files is correct and a single number would read as a tiny dataset.
 *
 * Lifecycle states are data variants, not errors (the `defineTool` contract): a missing,
 * in-flight, failed, or stale profile is an ordinary, expected outcome the model must be
 * able to reason about, so each returns in the ok channel.
 *
 * Every path it serves is projected into the frame-independent `/{analysisId}/…`
 * form. The record stores a path relative to the analysis root, and a step agent
 * resolves a relative path against its own working directory — thus the stored
 * form names a file that does not exist in the frame of the caller. The same
 * projection guards the step briefing (`app/data-profile-orientation.ts`).
 */

import { ok, type Result } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { profileCaveats, profileDatasetFileCount, profileFileRecords, profileGroups } from "../../app/data-profile-view.js";
import { scopeResource } from "../../auth/types.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { loadDataProfileStatus, type DataProfileFile, type DataProfileResult, type DataProfileStatus } from "../../state/index.js";
import { toAnalysisRootPath } from "../../workspace/paths.js";
import { defineTool, type ToolError } from "../define-tool.js";

/** Per-file records returned per page when the caller names none. */
const DEFAULT_PAGE_SIZE = 20;

/** Ceiling on `pageSize` — a page is a context-window budget, not a dump. */
const MAX_PAGE_SIZE = 100;

/**
 * Whether the served profile can be trusted to describe the analysis's CURRENT inputs.
 * `"stale"` still carries the full profile — a stale profile is far better than none —
 * but says plainly why it may be wrong.
 */
type Freshness = "ready" | "stale";

interface ProfileEnvelope {
    readonly state: Freshness;
    /** Why the profile may not describe the current inputs. Present only when `state` is `"stale"`. */
    readonly staleReason?: string;
    readonly profiledAt: string;
}

interface OverviewOutput extends ProfileEnvelope {
    readonly scope: "overview";
    readonly summary: string;
    readonly domain?: string;
    readonly subtype?: string;
    readonly organism?: DataProfileResult["organism"];
    readonly tissue?: string | null;
    readonly cellType?: string | null;
    readonly condition?: string | null;
    readonly experimentalDesign?: string;
    /** Dataset-wide findings the agent wrote, from whichever field the snapshot carries them in. */
    readonly caveats?: string[];
    readonly accessions?: string[];
    /** How many member records `scope:"files"` would page through — NOT the dataset's size. */
    readonly describedFileCount: number;
    /**
     * How many files the dataset holds, or `null` when the snapshot cannot say (one
     * written before any structure record existed). Reported separately from
     * `describedFileCount` because a profile describing eight members of several thousand
     * files is correct under this capability, and a single count would read as a dataset
     * of eight files.
     */
    readonly datasetFileCount: number | null;
    /** How many groups `scope:"groups"` would return; `null` on a snapshot that carries no structure. */
    readonly groupCount: number | null;
    /** Present when the two counts differ — says where the rest of the dataset is described. */
    readonly structureNote?: string;
    /**
     * The census, on a snapshot resolved under the partition: kept files, per-group
     * counts, the unclassified sweep, and the quarantine with its reasons.
     */
    readonly partition?: DataProfileResult["partition"];
    readonly coverage?: DataProfileResult["coverage"];
}

/**
 * The dataset's structure. A snapshot carrying none reports `available: false` rather
 * than an empty list: "this profile predates the structure" and "this dataset has no
 * structure" are different facts, and only one of them is true.
 *
 * A snapshot written under the previous model is served through `kinds`/`axes`, labelled
 * — the structure exists, and an agent must not be told the dataset has none.
 */
interface GroupsOutput extends ProfileEnvelope {
    readonly scope: "groups";
    readonly available: boolean;
    /** Authored under the previous model — `kinds`/`axes` rather than resolved groups. */
    readonly legacy?: boolean;
    readonly groups?: DataProfileResult["groups"];
    readonly dimensions?: DataProfileResult["dimensions"];
    readonly probes?: DataProfileResult["probes"];
    readonly partition?: DataProfileResult["partition"];
    readonly recipe?: DataProfileResult["recipe"];
    readonly kinds?: DataProfileResult["kinds"];
    readonly axes?: DataProfileResult["axes"];
    readonly coverage?: DataProfileResult["coverage"];
    readonly message?: string;
}

/**
 * The members the profile describes individually — annotated members on a resolved
 * snapshot, the notable-file records on an older one. Never the dataset: `datasetFileCount`
 * on the overview is what says how big that is.
 */
interface FilesOutput extends ProfileEnvelope {
    readonly scope: "files";
    readonly page: number;
    readonly pageSize: number;
    /** Every member record the profile holds — not just this page. */
    readonly total: number;
    /** True when records remain past this page. Truncation is always stated, never silent. */
    readonly hasMore: boolean;
    /** How many files the dataset holds, so a page of 20 never reads as the whole of it. */
    readonly datasetFileCount: number | null;
    readonly files: DataProfileFile[];
}

/**
 * No profile to serve — the honest lifecycle states, in the ok channel.
 *
 * Deliberately carries no staleness verdict. None of this variant's three
 * producers retains a comparand: an analysis that was never profiled and one
 * with no input files never had one, and `clearDataProfile` nulls
 * `seed_input_file_ids` along with every other profile column, so a cleared row
 * keeps no record of what it once covered. Such a field could only ever be
 * constant here, and a constant field carries no information while implying
 * that it does. `FailedOutput` omits one for the same reason — see its note.
 */
interface AbsentOutput {
    readonly state: "absent";
    readonly message: string;
}

interface PendingOutput {
    readonly state: "pending";
    readonly status: "pending" | "running";
    readonly message: string;
}

/**
 * A recorded failure with no profile to fall back on.
 *
 * Carries no staleness verdict, deliberately. Whether the failed attempt covered
 * the files the analysis holds NOW is not derivable here: this tool reads one
 * `cortex_analysis_state` row, the current input set is the embedder's knowledge,
 * and `seed_input_file_ids` is the most recently seeded set rather than a
 * per-attempt snapshot (`upsertAnalysis` overwrites it). A field reporting that
 * verdict could only ever hold one value, which carries no information while
 * implying that it does — and the tool description, being the whole of what an
 * agent knows about this tool, must not advertise a distinction it cannot make.
 *
 * `failedAt` is reported instead: a fact the row actually holds, and one an agent
 * that knows when the input set last changed can act on.
 */
interface FailedOutput {
    readonly state: "failed";
    readonly error: string | null;
    /** When the failure was recorded; `null` when the row holds no time. */
    readonly failedAt: string | null;
    readonly message: string;
}

export type InspectDataProfileOutput = OverviewOutput | GroupsOutput | FilesOutput | AbsentOutput | PendingOutput | FailedOutput;

/** Serve each per-file record with a path that resolves in the frame of the caller. */
function rootFilePaths(files: readonly DataProfileFile[], analysisId: string): DataProfileFile[] {
    return files.map((file) => ({ ...file, path: toAnalysisRootPath(analysisId, file.path) }));
}

/**
 * Serve each group with a display pattern that resolves in the frame of the caller.
 *
 * A pattern is a path with varying segments, thus it takes the same projection as a file
 * path. Its placeholders survive it: the projection only re-roots the pattern.
 */
function rootGroupPatterns(groups: NonNullable<DataProfileResult["groups"]>, analysisId: string): NonNullable<DataProfileResult["groups"]> {
    return groups.map((group) => ({ ...group, displayPattern: toAnalysisRootPath(analysisId, group.displayPattern) }));
}

function rootKindPatterns(kinds: NonNullable<DataProfileResult["kinds"]>, analysisId: string): NonNullable<DataProfileResult["kinds"]> {
    return kinds.map((kind) => ({ ...kind, pathPattern: toAnalysisRootPath(analysisId, kind.pathPattern) }));
}

/**
 * Name every reason the served profile may not describe the current inputs.
 *
 * Every reason is one the ledger row states outright: the row has moved off `completed`
 * while an older result is still on it, because `tryRerun`/`tryRetry` preserve
 * `data_profile_result` precisely so a prior profile stays servable while the next
 * attempt runs or after it fails.
 *
 * A changed input set is deliberately NOT among them. Re-profiling is invoked by the
 * embedder that owns the input mutation — it knows the set changed at the moment it
 * changed — so a row still reading `completed` is a row nothing has superseded. Deriving
 * a verdict here would mean re-deciding, from one table row, a question already answered
 * by the party that watched it happen.
 */
function stalenessReasons(status: DataProfileStatus): string[] {
    const reasons: string[] = [];
    if (status.status === "running" || status.status === "pending") {
        reasons.push("a re-profile is in progress — this is the previous profile");
    }
    if (status.status === "failed") {
        reasons.push(`the most recent profiling attempt failed (${status.error ?? "no reason recorded"}) — this is the previous profile`);
    }
    return reasons;
}

/**
 * The qualification the `failed` message must carry. A bare `failed: <error>`
 * reads as a verdict on whatever files the agent is currently holding, and
 * `message` is what an agent quotes back to the user — so the limit of what this
 * row can establish belongs in the prose channel, not only in the field set.
 */
const FAILURE_SCOPE_NOTE =
    "This records an earlier attempt; this row cannot establish whether it covered the input files the analysis " +
    "holds now, so do not read it as a verdict on the current data. Compare failedAt against when the input set " +
    "last changed, and re-profile if they have moved apart.";

export function createInspectDataProfileTool(pool: Pool) {
    return defineTool({
        id: "inspect_data_profile",
        description:
            "Read this analysis's data profile — the AUTHORITATIVE record of what the input dataset is: " +
            "organism and taxon id, scientific domain and subtype, tissue, cell type, condition, experimental design, " +
            "dataset-wide caveats, public accessions, the GROUPS of file the dataset is made of, the DIMENSIONS that vary " +
            "across it with the evidence behind each, and the file census (kept, unclassified, quarantined). " +
            "There is NO data-profile file in the workspace — this tool is the only way to read it. Do not search for one, " +
            "and do not rediscover these facts by listing or reading the raw input files. " +
            "Call it before you reason about the data (planning, writing analysis code, interpreting results). " +
            "scope:'overview' (the default) returns the dataset-level orientation plus the partition accounting — how many " +
            "files were kept, how many landed in no group, how many were quarantined — and how many members are described " +
            "individually. That last figure and the dataset's file count differ on purpose: a large dataset is described by " +
            "its groups, not file by file. " +
            "scope:'groups' returns the groups with their derived counts, display patterns, and slots, plus the dimensions " +
            "with their observations, reconciliations, and probe outcomes — this is where a dataset of thousands of files is " +
            "described. A profile written under the previous model returns its kinds and axes, labelled as such. " +
            "scope:'files' returns the individually annotated members, paged: page (1-based, default 1) and pageSize (default 20, max 100), " +
            "always with the true total and hasMore, so you can see exactly what you have not read yet. " +
            "For the paths of files no record describes, use scope:'groups' for the structure and list the workspace tree for the paths. " +
            "The state field says what you got: 'ready'; 'stale' (a profile is returned but may not describe the current " +
            "inputs — staleReason says why); 'pending' (profiling is still running); 'failed'; or 'absent' (never profiled, " +
            "or the analysis has no input files). " +
            "A 'failed' state reports a PAST attempt, with failedAt naming when it was recorded — it is not a verdict on the " +
            "input files you are holding now, and this tool cannot tell you whether that attempt covered them. Compare failedAt " +
            "against when the input set last changed before you conclude anything: if the data moved since, say the profile " +
            "needs re-running rather than diagnosing the data itself.",
        inputSchema: z.object({
            scope: z
                .enum(["overview", "groups", "files"])
                .optional()
                .describe(
                    "'overview' (default): dataset-level facts, the partition accounting, the annotated-member count, and the dataset file count. " +
                        "'groups': the groups the dataset is made of, with their slots, and the dimensions that vary across it. " +
                        "'files': paged records for the individually annotated members.",
                ),
            page: z.number().int().min(1).optional().describe("1-based page of member records. Only used when scope is 'files'. Default 1."),
            pageSize: z
                .number()
                .int()
                .min(1)
                .max(MAX_PAGE_SIZE)
                .optional()
                .describe(`Member records per page. Only used when scope is 'files'. Default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}.`),
        }),
        // `execute` defaults both fields internally, and the hook applies the same
        // defaults. Without them the ordinary call, which names no field at all,
        // gives no detail. `page` acts only on the `files` scope, as in `execute`.
        describeCall: ({ scope, page }) => ((scope ?? "overview") === "files" ? `files (page ${page ?? 1})` : (scope ?? "overview")),
        execute: async (input, ctx): Promise<Result<InspectDataProfileOutput, ToolError>> => {
            const resourceId = scopeResource(ctx.session.scope).resourceId;
            const status = unwrapOrThrow(await loadDataProfileStatus(pool, resourceId));

            // `loadDataProfileStatus` collapses "no analysis row" and "profile cleared"
            // into the same null, on purpose — both mean "no profile" to a consumer.
            if (!status) {
                return ok({
                    state: "absent",
                    message: "No data profile exists for this analysis. It has not been profiled, or its input files were removed.",
                });
            }

            const result = status.result;
            if (!result) {
                if (status.status === "failed") {
                    // A failure that DID leave a prior profile on the row never reaches
                    // here — it is served as `stale`, where `stalenessReasons` names the
                    // failed re-profile and compares the input sets through the single
                    // shared predicate. This branch is the case with nothing to compare.
                    return ok({
                        state: "failed",
                        error: status.error,
                        failedAt: status.completedAt,
                        message: `Data profiling failed and no earlier profile exists: ${status.error ?? "no reason recorded"}. ${FAILURE_SCOPE_NOTE}`,
                    });
                }
                if (status.status === "completed") {
                    // A completed profile with no result is the empty-manifest path: there
                    // were no input files to profile. "Absent" is the honest reading.
                    return ok({
                        state: "absent",
                        message: "Data profiling completed with no result — this analysis has no input files.",
                    });
                }
                return ok({
                    state: "pending",
                    status: status.status,
                    message: "Data profiling is still running; no profile is available yet. Proceed without it or ask the user to wait.",
                });
            }

            const reasons = stalenessReasons(status);
            const envelope: ProfileEnvelope =
                reasons.length > 0
                    ? { state: "stale", staleReason: reasons.join("; "), profiledAt: result.profiledAt }
                    : { state: "ready", profiledAt: result.profiledAt };

            const scope = input.scope ?? "overview";

            const describedFiles = profileFileRecords(result);
            const groups = profileGroups(result);

            if (scope === "overview") {
                const dataset = profileDatasetFileCount(result);
                const described = describedFiles.length;
                const structureNote =
                    dataset === null
                        ? "This profile predates the dataset-structure record, so only the individually described files are known; " +
                          "list the workspace tree for the rest."
                        : dataset !== described
                          ? `${described} of ${dataset} files are described individually. Call scope:'groups' for what the rest are, ` +
                            "and list the workspace tree for their paths."
                          : undefined;
                return ok({
                    ...envelope,
                    scope: "overview",
                    summary: result.summary,
                    domain: result.domain,
                    subtype: result.subtype,
                    organism: result.organism,
                    tissue: result.tissue,
                    cellType: result.cellType,
                    condition: result.condition,
                    experimentalDesign: result.experimentalDesign,
                    caveats: profileCaveats(result),
                    accessions: result.accessions,
                    describedFileCount: described,
                    datasetFileCount: dataset,
                    groupCount: result.groups || result.kinds ? groups.length : null,
                    ...(structureNote ? { structureNote } : {}),
                    ...(result.partition ? { partition: result.partition } : {}),
                    ...(result.coverage ? { coverage: result.coverage } : {}),
                });
            }

            if (scope === "groups") {
                if (result.groups) {
                    return ok({
                        ...envelope,
                        scope: "groups",
                        available: true,
                        groups: rootGroupPatterns(result.groups, resourceId),
                        ...(result.dimensions ? { dimensions: result.dimensions } : {}),
                        ...(result.probes ? { probes: result.probes } : {}),
                        ...(result.partition ? { partition: result.partition } : {}),
                        ...(result.recipe ? { recipe: result.recipe } : {}),
                    });
                }
                if (!result.kinds) {
                    return ok({
                        ...envelope,
                        scope: "groups",
                        available: false,
                        message:
                            "This profile was taken before the dataset-structure record existed, so it carries no groups. " +
                            "That is a fact about the profile, not about the dataset: use scope:'files' and the workspace " +
                            "listing tools, or re-profile the analysis.",
                    });
                }
                // The structure exists; only its vocabulary is older. Serving it labelled beats
                // reporting the scope unavailable, which would tell an agent the dataset has no
                // structure when the row plainly holds some.
                return ok({
                    ...envelope,
                    scope: "groups",
                    available: true,
                    legacy: true,
                    kinds: rootKindPatterns(result.kinds, resourceId),
                    ...(result.axes ? { axes: result.axes } : {}),
                    ...(result.coverage ? { coverage: result.coverage } : {}),
                    message:
                        "Authored under the previous model: these are kinds and axes, not resolved groups and dimensions. " +
                        "Counts and patterns were the profiler's own claims rather than a computed partition, and there is no " +
                        "unclassified sweep or quarantine accounting on a profile of that era.",
                });
            }

            const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
            const page = input.page ?? 1;
            const total = describedFiles.length;
            const start = (page - 1) * pageSize;
            const files = describedFiles.slice(start, start + pageSize);

            return ok({
                ...envelope,
                scope: "files",
                page,
                pageSize,
                total,
                hasMore: start + files.length < total,
                datasetFileCount: profileDatasetFileCount(result),
                files: rootFilePaths(files, resourceId),
            });
        },
    });
}
