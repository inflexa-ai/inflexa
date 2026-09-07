/**
 * The knowledge service seam of the harness.
 *
 * `KnowledgeClient` is the one contract between the harness and the remote
 * knowledge service: three typed operations and the snapshot they answer
 * from. The harness never knows about a license. It sees a client, or it sees
 * nothing, and an absent client is a normal state in which no knowledge tool
 * attaches. `createHttpKnowledgeClient` is the shipped realization over plain
 * HTTPS with the retry and timeout policy of the other external tools.
 *
 * Every operation answers a data variant. A service that is configured but
 * unreachable gives `{ match: "unavailable" }` after the retry policy, and the
 * caller continues from the prose skills. A 400 names the field and the
 * permitted values, thus a model corrects itself in one turn. The response
 * shapes below are the harness copy of the wire contract of the service, kept
 * lenient with `looseObject`, thus a richer answer of a later snapshot still
 * parses.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError, type ApiError } from "../lib/api-utils.js";

// ── The situation ───────────────────────────────────────────────────

/** The typed description of one analysis situation. Never a sample row and never an identifier. */
export interface KnowledgeSituation {
    readonly question: "differential_expression" | "enrichment" | "qc" | "full_plan";
    readonly modality: "bulk_rna_seq";
    readonly data_state: "fastq" | "counts" | "tpm_or_fpkm" | "log_normalized";
    readonly count_source?: "salmon" | "kallisto" | "star_featurecounts" | "rsem" | "unknown";
    /** Whether the length correction of a quantifier occurred. Never required: the service sets `unknown` on counts. */
    readonly import_state?: "quantifications" | "estimated_counts_with_lengths" | "corrected_counts" | "integer_counts" | "unknown";
    readonly organism: "human" | "mouse" | "other";
    readonly n_groups: number;
    readonly n_per_group_min: number;
    readonly n_per_group_max: number;
    readonly paired: boolean;
    readonly blocking_factor?: string | null;
    readonly batch: "none" | "known_balanced" | "known_confounded" | "suspected";
    readonly covariates?: readonly string[];
    readonly n_timepoints?: number | null;
    readonly library_type?: "polyA" | "total" | "three_prime" | "unknown";
    readonly strandedness?: "verified" | "declared_unverified" | "unknown";
    readonly interaction?: boolean;
    /** True for a classifier of the samples into classes; absent for a per-sample score. */
    readonly classifier?: boolean;
    readonly quality_flags?: readonly ("low_depth_sample" | "outlier_sample" | "sample_identity_doubt" | "high_duplication")[];
}

// ── The answers, as the harness reads them ──────────────────────────

const SnapshotRefSchema = z.object({ date: z.string(), digest: z.string() });

/** A method of the catalog by id and label. */
const MethodRefSchema = z.looseObject({ id: z.string(), label: z.string() });

/** Two rules of equal specificity and strength disagree on a parameter. The step omits the parameter and names both. */
const ProcedureConflictSchema = z.looseObject({
    parameter: z.string(),
    entries: z.array(z.looseObject({ rule: z.string(), value: z.unknown() })),
});

/** The step method is a declared substitute: `for` names the method of record it stands in for. */
const ProcedureSubstitutionSchema = z.looseObject({ for: z.string(), label: z.string(), template: z.string() });

/** No template of the requested language holds for the design; the step keeps the first template that holds. */
const ProcedureLimitSchema = z.looseObject({
    requested_language: z.enum(["R", "python"]),
    reason: z.string(),
    skipped: z.array(z.looseObject({ template: z.string(), missing: z.array(z.string()) })),
});

const ProcedureStepSchema = z.looseObject({
    step: z.string(),
    method: MethodRefSchema.optional(),
    template: z.string().optional(),
    rules: z.array(z.string()),
    flags: z.array(z.looseObject({ rule: z.string(), severity: z.string(), message: z.string(), outcome: z.string().optional() })).optional(),
    alternatives: z.array(z.looseObject({ method: z.string(), label: z.string(), when: z.string(), rules: z.array(z.string()) })).optional(),
    disputed: z.looseObject({ rule: z.string(), sides: z.array(z.string()) }).optional(),
    parameters: z.array(z.looseObject({ name: z.string(), value: z.unknown(), default_source: z.string().optional() })).optional(),
    conflicts: z.array(ProcedureConflictSchema).optional(),
    substitution: ProcedureSubstitutionSchema.optional(),
    limit: ProcedureLimitSchema.optional(),
});

const ClaimSchema = z.looseObject({
    id: z.string(),
    statement: z.string(),
    strength: z.string(),
    evidence: z.array(z.looseObject({ doi: z.string().optional(), pmid: z.string().optional(), title: z.string(), year: z.number(), direction: z.string() })),
});

export const RecommendResponseSchema = z.looseObject({
    match: z.enum(["applicable", "none", "flag"]),
    snapshot: SnapshotRefSchema,
    procedure: z.array(ProcedureStepSchema),
    uncovered: z.array(z.string()),
    flags: z.array(z.looseObject({ rule: z.string(), severity: z.string(), message: z.string(), outcome: z.string().optional() })),
    claims: z.array(ClaimSchema),
    nearest: z.array(z.looseObject({ claim: z.string(), title: z.string(), failed: z.array(z.string()) })).optional(),
    reason: z.string().optional(),
});
export type RecommendResponse = z.infer<typeof RecommendResponseSchema>;

const FindingSchema = z.looseObject({
    step_type: z.string(),
    severity: z.string(),
    rule: z.string(),
    message: z.string(),
    permitted: z.array(z.string()).optional(),
});

/** A drafted step that no rule covers in the situation: neither passed nor failed. */
const NotAssessedSchema = z.looseObject({ step_type: z.string(), reason: z.string(), message: z.string() });

export const CheckResponseSchema = z.looseObject({
    /** True when the assessed steps carry no violation and no warning. A step in `not_assessed` does not count. */
    ok: z.boolean(),
    snapshot: SnapshotRefSchema,
    violations: z.array(FindingSchema),
    warnings: z.array(FindingSchema),
    not_assessed: z.array(NotAssessedSchema).optional(),
});
export type CheckResponse = z.infer<typeof CheckResponseSchema>;

export const RenderResponseSchema = z.looseObject({
    ok: z.literal(true),
    snapshot: SnapshotRefSchema,
    template: z.looseObject({
        id: z.string(),
        version: z.string(),
        label: z.string(),
        /** The method the script runs: the substitute when the template is one. */
        method: MethodRefSchema,
        /** The method of record when the template is a declared substitute. */
        substitute_for: MethodRefSchema.optional(),
        language: z.string(),
    }),
    script: z.string(),
    slots: z.array(z.looseObject({ name: z.string(), value: z.unknown(), source: z.string(), adaptable: z.boolean(), lines: z.array(z.number()) })),
    environment: z.looseObject({ match: z.string() }),
    syntax: z.looseObject({ status: z.string() }),
    outputs: z.array(z.looseObject({ name: z.string(), path: z.string(), description: z.string().optional() })),
    decision_record: z.record(z.string(), z.unknown()),
});
export type RenderResponse = z.infer<typeof RenderResponseSchema>;

const ValidationFailureSchema = z.looseObject({
    error: z.literal("validation"),
    message: z.string(),
    issues: z.array(
        z.looseObject({
            message: z.string().optional(),
            reason: z.string().optional(),
            field: z.string().optional(),
            slot: z.string().optional(),
            permitted: z.array(z.string()).optional(),
        }),
    ),
});

/** The preferences of the caller: the language of the template the answer names. */
export interface KnowledgePreferences {
    readonly language?: "R" | "python";
}

/** What a drafted step carries into the check. */
export interface DraftedStep {
    readonly step_type: string;
    readonly method: string;
    /** The catalog id of the method (`M-dddd`), copied from the recommendation. An exact match wins over the wording. */
    readonly method_id?: string;
    readonly package?: string;
    readonly parameters?: readonly { readonly name: string; readonly value: string | number | boolean }[];
    /** The outcome the step states when the design forbids inference, for example `descriptive_only`. */
    readonly outcome?: string;
}

export interface FarmPackage {
    readonly name: string;
    readonly version: string;
}

/** The service could not answer after the retry policy. The run continues from the prose skills. */
export interface KnowledgeUnavailable {
    readonly match: "unavailable";
    readonly reason: string;
}

/** The service refused the request and named the field or the slot and the permitted values. */
export interface KnowledgeRejected {
    readonly match: "rejected";
    readonly message: string;
    readonly issues: readonly {
        readonly field?: string;
        readonly slot?: string;
        readonly message?: string;
        readonly reason?: string;
        readonly permitted?: readonly string[];
    }[];
}

export interface KnowledgeClient {
    recommend(
        situation: KnowledgeSituation,
        responseFormat?: "concise" | "detailed",
        preferences?: KnowledgePreferences,
    ): Promise<RecommendResponse | KnowledgeUnavailable | KnowledgeRejected>;
    check(situation: KnowledgeSituation, steps: readonly DraftedStep[]): Promise<CheckResponse | KnowledgeUnavailable | KnowledgeRejected>;
    render(
        template: string,
        slots: Readonly<Record<string, unknown>>,
        farm?: readonly FarmPackage[],
    ): Promise<RenderResponse | KnowledgeUnavailable | KnowledgeRejected>;
}

export interface HttpKnowledgeClientConfig {
    /** The service origin, for example `https://knowledge.inflexa.ai`. */
    readonly baseUrl: string;
    /** The bearer key. The license of the service. */
    readonly apiKey: string;
    readonly timeoutMs?: number;
    readonly maxRetries?: number;
}

function rejectedOf(error: ApiError): KnowledgeRejected | undefined {
    if (error.type !== "http_status" || error.status !== 400) return undefined;
    let raw: unknown;
    try {
        raw = JSON.parse(error.body);
    } catch {
        return { match: "rejected", message: error.body || "the service refused the request", issues: [] };
    }
    const parsed = ValidationFailureSchema.safeParse(raw);
    if (!parsed.success) return { match: "rejected", message: error.body, issues: [] };
    return { match: "rejected", message: parsed.data.message, issues: parsed.data.issues };
}

export function createHttpKnowledgeClient(config: HttpKnowledgeClientConfig): KnowledgeClient {
    const base = config.baseUrl.replace(/\/+$/, "");
    const options = {
        method: "POST" as const,
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        timeoutMs: config.timeoutMs ?? 30_000,
        maxRetries: config.maxRetries ?? 2,
        retryDelayMs: 500,
    };

    async function post<S extends z.ZodType>(path: string, body: unknown, schema: S): Promise<z.infer<S> | KnowledgeUnavailable | KnowledgeRejected> {
        const result = await apiFetchValidated(`${base}${path}`, schema, { ...options, body: JSON.stringify(body) });
        if (result.isOk()) return result.value;
        const rejected = rejectedOf(result.error);
        if (rejected) return rejected;
        return { match: "unavailable", reason: describeApiError(result.error) };
    }

    return {
        recommend: (situation, responseFormat, preferences) =>
            post(
                "/v1/recommend",
                { situation, ...(responseFormat ? { response_format: responseFormat } : {}), ...(preferences ? { preferences } : {}) },
                RecommendResponseSchema,
            ),
        check: (situation, steps) => post("/v1/check", { situation, steps }, CheckResponseSchema),
        render: (template, slots, farm) => post("/v1/template/render", { template, slots, ...(farm ? { farm } : {}) }, RenderResponseSchema),
    };
}
