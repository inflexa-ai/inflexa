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
 * source for dataset facts (organism, domain, design, per-file type/format/dimensions),
 * and it is why the record is served in full rather than summarized: an agent that
 * cannot pull a fact here has no fallback but to re-derive it from the raw bytes.
 *
 * Bounded by construction. `inspect_run` is the cautionary counter-example — it caps
 * its query at 50 rows with no `limit` parameter and no signal to the caller, so a
 * 51st run is simply invisible. Here the per-file scope is explicitly paged and always
 * reports `total` and `hasMore`: an elided tail is a fact the model can see and act on,
 * never a silent truncation.
 *
 * Lifecycle states are data variants, not errors (the `defineTool` contract): a missing,
 * in-flight, failed, or stale profile is an ordinary, expected outcome the model must be
 * able to reason about, so each returns in the ok channel.
 */

import { ok, type Result } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { isDataProfileStale } from "../../app/data-profile-policy.js";
import { scopeResource } from "../../auth/types.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { loadDataProfileStatus, type DataProfileFile, type DataProfileResult, type DataProfileStatus } from "../../state/index.js";
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
    readonly qualityAssessment?: DataProfileResult["qualityAssessment"];
    readonly accessions?: string[];
    /** How many per-file records `scope:"files"` would page through. */
    readonly fileCount: number;
}

interface FilesOutput extends ProfileEnvelope {
    readonly scope: "files";
    readonly page: number;
    readonly pageSize: number;
    /** Every per-file record the profile holds — not just this page. */
    readonly total: number;
    /** True when records remain past this page. Truncation is always stated, never silent. */
    readonly hasMore: boolean;
    readonly files: DataProfileFile[];
}

/** No profile to serve — the honest lifecycle states, in the ok channel. */
interface AbsentOutput {
    readonly state: "absent";
    readonly message: string;
}

interface PendingOutput {
    readonly state: "pending";
    readonly status: "pending" | "running";
    readonly message: string;
}

interface FailedOutput {
    readonly state: "failed";
    readonly error: string | null;
    readonly message: string;
}

export type InspectDataProfileOutput = OverviewOutput | FilesOutput | AbsentOutput | PendingOutput | FailedOutput;

/**
 * Name every reason the served profile may not describe the current inputs.
 *
 * Two independent things make a profile stale, and both are ordinary. The input set can
 * change under a completed profile (`isDataProfileStale` — the same predicate the
 * embedder's re-trigger policy uses; staleness is defined once, in
 * `app/data-profile-policy.ts`, not re-derived here). And the ledger can have moved off
 * `completed` while an older result is still on the row: `tryRerun`/`tryRetry` preserve
 * `data_profile_result` precisely so a prior profile stays servable while the next
 * attempt runs or after it fails.
 */
function stalenessReasons(status: DataProfileStatus, result: DataProfileResult): string[] {
    const reasons: string[] = [];
    if (isDataProfileStale(status.seedInputFileIds ?? [], result.inputFileIds)) {
        reasons.push("the analysis's input file set changed after this profile was taken");
    }
    if (status.status === "running" || status.status === "pending") {
        reasons.push("a re-profile is in progress — this is the previous profile");
    }
    if (status.status === "failed") {
        reasons.push(`the most recent profiling attempt failed (${status.error ?? "no reason recorded"}) — this is the previous profile`);
    }
    return reasons;
}

export function createInspectDataProfileTool(pool: Pool) {
    return defineTool({
        id: "inspect_data_profile",
        description:
            "Read this analysis's data profile — the AUTHORITATIVE record of what the input dataset is: " +
            "organism and taxon id, scientific domain and subtype, tissue, cell type, condition, experimental design, " +
            "dataset-wide quality concerns and strengths, public accessions, and per-file data type, format, " +
            "row/column dimensions, tags, warnings, and profiling metrics. " +
            "There is NO data-profile file in the workspace — this tool is the only way to read it. Do not search for one, " +
            "and do not rediscover these facts by listing or reading the raw input files. " +
            "Call it before you reason about the data (planning, writing analysis code, interpreting results). " +
            "scope:'overview' (the default) returns the dataset-level orientation plus the number of profiled files. " +
            "scope:'files' returns the per-file records, paged: page (1-based, default 1) and pageSize (default 20, max 100), " +
            "always with the true total and hasMore, so you can see exactly what you have not read yet. " +
            "The state field says what you got: 'ready'; 'stale' (a profile is returned but may not describe the current " +
            "inputs — staleReason says why); 'pending' (profiling is still running); 'failed'; or 'absent' (never profiled, " +
            "or the analysis has no input files).",
        inputSchema: z.object({
            scope: z
                .enum(["overview", "files"])
                .optional()
                .describe("'overview' (default): dataset-level facts + file count. 'files': paged per-file records."),
            page: z.number().int().min(1).optional().describe("1-based page of per-file records. Only used when scope is 'files'. Default 1."),
            pageSize: z
                .number()
                .int()
                .min(1)
                .max(MAX_PAGE_SIZE)
                .optional()
                .describe(`Per-file records per page. Only used when scope is 'files'. Default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}.`),
        }),
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
                    return ok({
                        state: "failed",
                        error: status.error,
                        message: `Data profiling failed and no earlier profile exists: ${status.error ?? "no reason recorded"}.`,
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

            const reasons = stalenessReasons(status, result);
            const envelope: ProfileEnvelope =
                reasons.length > 0
                    ? { state: "stale", staleReason: reasons.join("; "), profiledAt: result.profiledAt }
                    : { state: "ready", profiledAt: result.profiledAt };

            if ((input.scope ?? "overview") === "overview") {
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
                    qualityAssessment: result.qualityAssessment,
                    accessions: result.accessions,
                    fileCount: result.files.length,
                });
            }

            const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
            const page = input.page ?? 1;
            const total = result.files.length;
            const start = (page - 1) * pageSize;
            const files = result.files.slice(start, start + pageSize);

            return ok({
                ...envelope,
                scope: "files",
                page,
                pageSize,
                total,
                hasMore: start + files.length < total,
                files,
            });
        },
    });
}
