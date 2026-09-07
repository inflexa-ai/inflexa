/**
 * The run record of the Phase 0 evaluation: the shape the runner writes for
 * one attempt, and the shape the scorer, the judge, and the report read back.
 *
 * A record carries the complete identity of the experiment (the campaign, the
 * arm, the seed, the split, the connection settings, the manifest by digest,
 * and the served snapshot), every tool call with its outcome, and every call
 * to the knowledge service with its request and its trimmed response. The
 * response is the evidence of the grounding gate: the scorer compares the
 * claim ids of a plan with the claims the service returned for the situation
 * of the run on the exact snapshot digest, thus a fabricated claim and an
 * inapplicable claim stay apart from an unresolved one.
 *
 * `FullRunRecord` is the record of the headless end-to-end runner: the same
 * head plus the profile, the plan, the executed run, the usage per role and
 * per step, and the outputs of the attempt.
 *
 * The manifest gate lives here too: `laneDifferences` names every field on
 * which a lane differs from the frozen campaign, and `splitOf` gives the split
 * of one task under one seed.
 */

import type { TokenUsageRollup } from "@inflexa-ai/harness";

import type { Manifest } from "./freeze.js";
import type { ModelConnection } from "./provider.js";

// ── One call to the knowledge service ───────────────────────────────

export type KnowledgeOp = "recommend" | "check" | "render";

/**
 * One call of the run to the knowledge service, as the recording client
 * pushes it. `seq` is the position of the call in the list of the run. The
 * response is trimmed to the evidence: for `recommend` the match, the
 * snapshot, the normalized situation, the procedure (step, method id,
 * template, rules, flags), the claim ids, the flags, the dropped and the
 * uncovered steps; for `check` the verdict, the snapshot, the violations, the
 * warnings, and the steps not assessed; for `render` the snapshot, the
 * template, the slots, the decision record, and the sha256 of the script,
 * never the script body. An unavailable or a rejected answer is kept whole.
 * `responseChars` is the size of the untrimmed response, thus the size of an
 * answer can be compared across campaigns.
 */
export interface KnowledgeCall {
    readonly seq: number;
    readonly op: KnowledgeOp;
    readonly request: unknown;
    readonly response: unknown;
    readonly responseChars: number;
    readonly elapsedMs: number;
}

// ── One tool call of the planner ────────────────────────────────────

/** The three live outcomes of the loop plus `incomplete`: a dispatch that the record never saw finish. */
export type ToolCallOutcome = "ok" | "error" | "denied" | "incomplete";

export interface ToolCallRecord {
    readonly toolUseId: string;
    readonly name: string;
    readonly input: unknown;
    readonly outcome: ToolCallOutcome;
    /** The time around the dispatch of the round, as the loop reports it. Absent when the loop measured none. */
    readonly durationMs?: number;
}

// ── The identity of the run ─────────────────────────────────────────

/** The provider settings of the lane, without the key variable. */
export type RunConnection = Pick<ModelConnection, "provider" | "baseUrl" | "providerOrder" | "requestTimeoutMs">;

/** The split of the run under the manifest; `none` when the task or the seed is outside the manifest. */
export type RunSplit = "development" | "held_out" | "none";

export interface RunRecord {
    readonly campaign: string;
    readonly condition: "with" | "without";
    readonly model: string;
    readonly task: string;
    readonly run: number;
    /** The simulation seed of the dataset the profile describes. */
    readonly seed: number;
    readonly split: RunSplit;
    readonly startedAt: string;
    readonly elapsedMs: number;
    readonly outcome: string;
    readonly planId?: string;
    readonly plan?: unknown;
    readonly question?: string;
    readonly error?: string;
    readonly usage: Record<string, number>;
    readonly toolCalls: readonly ToolCallRecord[];
    /** Every call of the run to the knowledge service, in order. Empty in the `without` arm. */
    readonly knowledgeCalls: readonly KnowledgeCall[];
    readonly snapshot?: { readonly date: string; readonly digest: string };
    readonly connection: RunConnection;
    /** The frozen manifest the lane ran under, by path and digest. Absent only for an exploratory lane without a manifest. */
    readonly manifest?: { readonly path: string; readonly digest: string };
    /** Set when the lane ran outside the manifest under `--exploratory`. */
    readonly exploratory?: true;
}

// ── The record of the end-to-end runner ─────────────────────────────

export interface FullRunStep {
    readonly stepId: string;
    readonly agent: string;
    readonly status: string;
    readonly durationMs: number | null;
    readonly finishReason: string | null;
    readonly hitMaxSteps: boolean;
    readonly error: string | null;
    readonly blockedReason: string | null;
}

/**
 * The record of one end-to-end attempt: the head of `RunRecord` plus the
 * sections of the execution. `run`, `plan`, `planId`, and `usage` of the head
 * give way to the sections of the same name.
 */
export interface FullRunRecord extends Omit<RunRecord, "run" | "plan" | "planId" | "usage"> {
    readonly identity: {
        readonly campaign: string;
        readonly arm: string;
        readonly task: string;
        readonly run: number;
        readonly seed: number;
        readonly models_by_role: Record<string, string>;
        readonly snapshot_digest: string | null;
        readonly image_digest: string | null;
        readonly farm_lock_sha256: string | null;
        readonly refs_receipt: unknown;
        readonly harness_commit: string;
    };
    readonly profile: { readonly status: string; readonly durationMs: number; readonly result: unknown };
    readonly plan: {
        readonly planId: string | null;
        readonly outcome: string;
        readonly clarifications: readonly { readonly question: string; readonly answer: string; readonly usage?: TokenUsageRollup }[];
        readonly plan: unknown;
    };
    readonly run: {
        readonly runId: string | null;
        readonly status: string;
        readonly error: string | null;
        readonly synthesis_status: string;
        readonly steps: readonly FullRunStep[];
        readonly artifacts: readonly unknown[];
        readonly environment_missing: readonly string[];
    };
    readonly usage: { readonly byRole: Record<string, TokenUsageRollup>; readonly byStep: Record<string, TokenUsageRollup>; readonly total: TokenUsageRollup };
    readonly toolCallsByStep: Record<string, readonly ToolCallRecord[]>;
    readonly knowledgeTemplateCalls: readonly KnowledgeCall[];
    readonly failures: readonly { readonly stage: string; readonly message: string }[];
    readonly timings: Record<string, number>;
    readonly outputs: {
        readonly de_table: string | null;
        readonly enrichment_table: string | null;
        readonly figures: readonly string[];
        readonly synthesis: string | null;
        readonly report_step_summary: string | null;
    };
    readonly transcript_source: string;
}

// ── The manifest gate ───────────────────────────────────────────────

/** What one lane is about to run, as the gate compares it with the manifest. */
export interface LaneIdentity {
    readonly condition: "with" | "without";
    readonly connection: ModelConnection;
    readonly seed: number;
    /** The digest the service serves; given in the `with` arm only. */
    readonly snapshotDigest?: string;
    readonly taskIds: readonly string[];
    /** The digest of the task set file the lane reads. */
    readonly tasksDigest?: string;
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
    return (a ?? []).join(",") === (b ?? []).join(",");
}

function armDifferences(arm: Manifest["arms"][number], connection: ModelConnection): string[] {
    const differences: string[] = [];
    if (arm.provider !== connection.provider) differences.push(`the arm ${arm.name} provider ${connection.provider} is not the frozen ${arm.provider}`);
    if (arm.baseUrl !== connection.baseUrl) differences.push(`the arm ${arm.name} baseUrl ${connection.baseUrl ?? "(none)"} is not the frozen ${arm.baseUrl ?? "(none)"}`);
    if (!sameList(arm.providerOrder, connection.providerOrder)) {
        differences.push(`the arm ${arm.name} providerOrder ${connection.providerOrder?.join(",") ?? "(none)"} is not the frozen ${arm.providerOrder?.join(",") ?? "(none)"}`);
    }
    if (arm.requestTimeoutMs !== connection.requestTimeoutMs) {
        differences.push(`the arm ${arm.name} requestTimeoutMs ${connection.requestTimeoutMs ?? "(none)"} is not the frozen ${arm.requestTimeoutMs ?? "(none)"}`);
    }
    return differences;
}

/**
 * The fields on which a lane differs from the frozen campaign; empty when the
 * lane is inside the manifest. A lane is inside when an arm of the manifest
 * has its condition, model, and provider settings, its seed is a frozen seed
 * of the split of every task, its served snapshot is the frozen corpus, and
 * its tasks are frozen tasks from the frozen task set file.
 */
export function laneDifferences(manifest: Manifest | undefined, lane: LaneIdentity): string[] {
    if (!manifest) return ["the campaign has no manifest"];
    const differences: string[] = [];
    const { connection } = lane;
    const candidates = manifest.arms.filter((arm) => arm.condition === lane.condition && arm.model === connection.model);
    if (candidates.length === 0) {
        differences.push(`the arm ${lane.condition} ${connection.provider}:${connection.model} is not a frozen arm`);
    } else {
        const exact = candidates.find((arm) => armDifferences(arm, connection).length === 0);
        if (!exact) differences.push(...armDifferences(candidates[0]!, connection));
    }
    const seeds = [...manifest.seeds.development, ...manifest.seeds.held_out];
    if (!seeds.includes(lane.seed)) {
        differences.push(`the seed ${lane.seed} is not a frozen seed (development [${manifest.seeds.development.join(", ")}], held out [${manifest.seeds.held_out.join(", ")}])`);
    }
    if (lane.condition === "with" && lane.snapshotDigest !== manifest.corpus.digest) {
        differences.push(`the served snapshot ${lane.snapshotDigest ?? "(none)"} is not the frozen ${manifest.corpus.digest}`);
    }
    const unknown = lane.taskIds.filter((id) => !manifest.task_set.ids.includes(id));
    if (unknown.length > 0) differences.push(`the task ${unknown.join(", ")} is not in the frozen task set`);
    // A frozen seed serves the tasks of its own split only: a development task
    // under a held-out seed would spend the held-out seed before the confirmatory campaign.
    const seedSplit = manifest.seeds.development.includes(lane.seed) ? "development" : manifest.seeds.held_out.includes(lane.seed) ? "held_out" : undefined;
    if (seedSplit) {
        const crossing = lane.taskIds.filter((id) => manifest.task_set.ids.includes(id) && splitOf(manifest, id, lane.seed) === "none");
        if (crossing.length > 0) differences.push(`the task ${crossing.join(", ")} is not in the ${seedSplit} split of the seed ${lane.seed}`);
    }
    if (lane.tasksDigest !== undefined && lane.tasksDigest !== manifest.task_set.digest) {
        differences.push(`the task set digest ${lane.tasksDigest} is not the frozen ${manifest.task_set.digest}`);
    }
    return differences;
}

/** The split of one task under one seed: both frozen in the same split, or `none`. */
export function splitOf(manifest: Manifest | undefined, taskId: string, seed: number): RunSplit {
    if (!manifest) return "none";
    if (manifest.task_set.split.development.includes(taskId) && manifest.seeds.development.includes(seed)) return "development";
    if (manifest.task_set.split.held_out.includes(taskId) && manifest.seeds.held_out.includes(seed)) return "held_out";
    return "none";
}
