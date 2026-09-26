/**
 * The knowledge service seam of the harness.
 *
 * `KnowledgeClient` is the one contract between the harness and the remote
 * knowledge service: four typed operations and the snapshot they answer
 * from. The harness never knows about a license. It sees a client, or it sees
 * nothing, and an absent client is a normal state in which no knowledge tool
 * attaches. `createHttpKnowledgeClient` is the shipped realization over plain
 * HTTPS with the retry and timeout policy of the other external tools.
 *
 * Every operation answers a data variant. A service that is configured but
 * unreachable gives `{ match: "unavailable" }` after the retry policy, and the
 * caller continues from the prose skills. A 400 names the field and the
 * permitted values, thus a model corrects itself in one turn. A 404 on the
 * contract lookup names the `template` field the same way. The response
 * shapes below are the harness copy of the wire contract of the service, kept
 * lenient with `looseObject`, thus a richer answer of a later snapshot still
 * parses.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError, type ApiError } from "../lib/api-utils.js";

// ── The situation ───────────────────────────────────────────────────

/** The role of the blocking factor. A role and never a column name, because the situation leaves the machine. */
export type BlockingRole = "individual" | "cell_line" | "litter" | "site" | "pair" | "other";
/** The role of a covariate of the design. A role and never a column name. */
export type CovariateRole = "sex" | "age" | "clinical" | "technical" | "other";
/** The role of the numeric variable of interest when the question is a trend, not a comparison of groups. */
export type PredictorRole = "dose" | "time" | "age" | "score" | "other";

/** The typed description of one analysis situation. Never a sample row, never an identifier, and never a column name. */
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
    /** The total number of biological samples. Never required. */
    readonly n_samples?: number;
    /** The number of samples with an observed event, for a survival question. Never required. */
    readonly n_events?: number;
    readonly paired: boolean;
    /** The role of the blocking factor, or null. The column name stays on the machine. */
    readonly blocking_factor?: BlockingRole | null;
    /** How the blocking factor relates to the condition: crossed, or nested inside one condition. */
    readonly block_structure?: "crossed" | "nested";
    readonly batch: "none" | "known_balanced" | "known_confounded" | "known_unbalanced" | "suspected";
    /** The role of each covariate of the design, one entry per covariate. The column names stay on the machine. */
    readonly covariates?: readonly CovariateRole[];
    readonly n_timepoints?: number | null;
    /** The role of the numeric variable of interest when the question is a trend over it; then `n_groups` is 1. The column name stays on the machine. */
    readonly continuous_predictor?: PredictorRole | null;
    /** True when some columns of the count table are technical replicates of one biological sample. */
    readonly technical_replicates?: boolean;
    /** The row unit of the count table. Absent for a gene-level table. */
    readonly feature_level?: "gene" | "exon" | "transcript";
    readonly library_type?: "polyA" | "total" | "three_prime" | "unknown";
    readonly strandedness?: "verified" | "declared_unverified" | "unknown";
    readonly interaction?: boolean;
    /** True for a classifier of the samples into classes; absent for a per-sample score. */
    readonly classifier?: boolean;
    readonly quality_flags?: readonly ("low_depth_sample" | "outlier_sample" | "sample_identity_doubt" | "high_duplication" | "degraded_rna")[];
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

/**
 * No template of the requested language is eligible; the step keeps the first template that is. A skipped template
 * lacks a design requirement (`missing`), or its slot refuses a value that the rules give (`refused`).
 */
const ProcedureLimitSchema = z.looseObject({
    requested_language: z.enum(["R", "python"]),
    reason: z.string(),
    skipped: z.array(z.looseObject({ template: z.string(), missing: z.array(z.string()), refused: z.string().optional() })),
});

/** The rules select a method for the step, and no template of the method holds: the knowledge covers the step, and no vetted script does. */
const ProcedureUnrealizedSchema = z.looseObject({
    reason: z.string(),
    templates: z.array(z.looseObject({ template: z.string(), why: z.string() })),
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
    unrealized: ProcedureUnrealizedSchema.optional(),
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
    /** The steps whose method has no eligible template in this situation. Absent when none. */
    unrealized: z.array(z.string()).optional(),
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
    /** The script with each local slot as its marker `{{name}}`. The host binds the local values before it writes the file. */
    script: z.string(),
    /** A local slot entry has no value: the host binds it. */
    slots: z.array(
        z.looseObject({
            name: z.string(),
            value: z.unknown().optional(),
            source: z.string(),
            adaptable: z.boolean(),
            lines: z.array(z.number()),
            read: z.boolean().optional(),
        }),
    ),
    /** The local slots the host must bind: each marker still in `script`. */
    local_slots: z.array(z.string()).optional(),
    environment: z.looseObject({ match: z.string() }),
    syntax: z.looseObject({ status: z.string() }),
    outputs: z.array(z.looseObject({ name: z.string(), path: z.string(), description: z.string().optional() })),
    decision_record: z.record(z.string(), z.unknown()),
});
export type RenderResponse = z.infer<typeof RenderResponseSchema>;

// ── The template contract ───────────────────────────────────────────

const SlotScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** A slot value on the wire: a scalar, or a list of scalars. */
const SlotValueSchema = z.union([SlotScalarSchema, z.array(SlotScalarSchema)]);

/**
 * One slot of a template with the constraint a caller value must obey.
 * `adaptable: false` marks a pinned slot: the render refuses a caller value
 * for it. An adaptable slot without a default is required unless `required`
 * is false.
 */
const TemplateParameterSchema = z.looseObject({
    name: z.string(),
    type: z.string(),
    description: z.string(),
    adaptable: z.boolean(),
    /** True for a slot whose value is a fact of the machine (a path, a column name, a level label, a formula): the host binds it, and the service never sees it. */
    local: z.boolean().optional(),
    required: z.boolean().optional(),
    default: SlotValueSchema.optional(),
    default_source: z.string().optional(),
    enum: z.array(z.string()).optional(),
    pattern: z.string().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
});
export type TemplateParameter = z.infer<typeof TemplateParameterSchema>;

/** A file the script reads. The path names the slot that gives it, for example `{{counts_path}}`. */
const TemplateInputSchema = z.looseObject({ name: z.string(), path: z.string(), description: z.string().optional() });

/**
 * The contract of one template as `GET /v1/templates/{id}` serves it: every
 * slot, pinned ones included, the inputs, and the outputs. The service adds
 * fields such as `step_types` and `environment`; they pass through the loose
 * remainder.
 */
export const TemplateContractSchema = z.looseObject({
    id: z.string(),
    version: z.string(),
    label: z.string(),
    /** The catalog id of the method the script runs. */
    method: z.string(),
    /** The catalog id of the method of record when the template is a declared substitute. */
    substitute_for: z.string().optional(),
    language: z.string(),
    /** The design requirements the script realizes. Absent: not subject to them. */
    honors: z.array(z.string()).optional(),
    parameters: z.array(TemplateParameterSchema),
    inputs: z.array(TemplateInputSchema).optional(),
    outputs: z.array(z.looseObject({ name: z.string(), path: z.string(), description: z.string().optional() })),
    /** The input requirements in prose, from the applicability of the template. */
    notes: z.string().optional(),
});
export type TemplateContract = z.infer<typeof TemplateContractSchema>;

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

/**
 * The service serves another release than the one the plan pinned, and it
 * did no work. A plan is not moved to a new release in silence: the caller
 * proceeds as with an unavailable service, and it states the two digests.
 */
export interface KnowledgeSnapshotMismatch {
    readonly match: "snapshot_mismatch";
    readonly message: string;
    readonly expected: string;
    readonly served: { readonly date: string; readonly digest: string };
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

/** What a render call carries beside the template and the slots. */
export interface RenderCallOptions {
    /** The id of the plan step that runs the script. */
    readonly step?: string;
    /** The claims of the plan step that selected the template. Each must resolve in the served snapshot. */
    readonly claims?: readonly string[];
    /** The release digest the plan pinned. The service refuses another release with `snapshot_mismatch`. */
    readonly expectedSnapshot?: string;
}

export interface KnowledgeClient {
    /** `expectedSnapshot` pins the release of an earlier answer of the same plan; the first call of a plan has none. */
    recommend(
        situation: KnowledgeSituation,
        responseFormat?: "concise" | "detailed",
        preferences?: KnowledgePreferences,
        expectedSnapshot?: string,
    ): Promise<RecommendResponse | KnowledgeUnavailable | KnowledgeRejected | KnowledgeSnapshotMismatch>;
    check(
        situation: KnowledgeSituation,
        steps: readonly DraftedStep[],
        expectedSnapshot?: string,
    ): Promise<CheckResponse | KnowledgeUnavailable | KnowledgeRejected | KnowledgeSnapshotMismatch>;
    /** `slots` never holds a local slot: the host binds those after the render, on the machine. */
    render(
        template: string,
        slots: Readonly<Record<string, unknown>>,
        farm?: readonly FarmPackage[],
        options?: RenderCallOptions,
    ): Promise<RenderResponse | KnowledgeUnavailable | KnowledgeRejected | KnowledgeSnapshotMismatch>;
    /**
     * The slot contract of a template, by reference (`tpl-x@1.0.0`) or by id.
     * The service serves one version per snapshot, thus the answer carries the
     * version it serves and the caller compares it with the reference. An
     * unknown template is `rejected` with the field `template`.
     */
    contract(template: string): Promise<TemplateContract | KnowledgeUnavailable | KnowledgeRejected>;
}

export interface HttpKnowledgeClientConfig {
    /** The service origin, for example `https://knowledge.inflexa.ai`. */
    readonly baseUrl: string;
    /** The bearer key. The license of the service. */
    readonly apiKey: string;
    readonly timeoutMs?: number;
    readonly maxRetries?: number;
}

/** The `message` of an error envelope, or the body itself when it is not one. */
function messageOf(body: string): string | undefined {
    try {
        const raw: unknown = JSON.parse(body);
        if (raw !== null && typeof raw === "object" && "message" in raw && typeof raw.message === "string") return raw.message;
    } catch {
        // Not JSON: the body is the message.
    }
    return body || undefined;
}

/** The template id of a reference: `tpl-x@1.0.0` gives `tpl-x`. The service serves one version, thus the route takes the id alone. */
function templateIdOf(reference: string): string {
    const at = reference.indexOf("@");
    return at < 0 ? reference : reference.slice(0, at);
}

const SnapshotMismatchSchema = z.looseObject({
    error: z.literal("snapshot_mismatch"),
    message: z.string(),
    expected: z.string(),
    served: SnapshotRefSchema,
});

/**
 * A 400 is a rejection that names the field and the permitted values. A 404
 * is one only on a lookup route, where `notFoundField` names the field whose
 * value the service does not hold. A 409 is a snapshot mismatch: the service
 * serves another release than the pinned one. Every other failure is
 * `unavailable`.
 */
function refusalOf(error: ApiError, notFoundField?: string): KnowledgeRejected | KnowledgeSnapshotMismatch | undefined {
    if (error.type !== "http_status") return undefined;
    if (error.status === 404 && notFoundField) {
        const message = messageOf(error.body) ?? `no such ${notFoundField}`;
        return { match: "rejected", message, issues: [{ field: notFoundField, message }] };
    }
    if (error.status === 409) {
        let raw: unknown;
        try {
            raw = JSON.parse(error.body);
        } catch {
            return undefined;
        }
        const parsed = SnapshotMismatchSchema.safeParse(raw);
        if (!parsed.success) return undefined;
        return { match: "snapshot_mismatch", message: parsed.data.message, expected: parsed.data.expected, served: parsed.data.served };
    }
    if (error.status !== 400) return undefined;
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
    // Trim the trailing slashes with a loop, not a regex: CodeQL flags `/\/+$/` on library input as polynomial.
    let base = config.baseUrl;
    while (base.endsWith("/")) base = base.slice(0, -1);
    const authorization = `Bearer ${config.apiKey}`;
    const policy = { timeoutMs: config.timeoutMs ?? 30_000, maxRetries: config.maxRetries ?? 2, retryDelayMs: 500 };

    /** One call of the service: a POST with a JSON body, or a GET without one. Every call carries the bearer key. */
    async function call<S extends z.ZodType>(
        method: "GET" | "POST",
        path: string,
        body: unknown,
        schema: S,
        notFoundField?: string,
    ): Promise<z.infer<S> | KnowledgeUnavailable | KnowledgeRejected | KnowledgeSnapshotMismatch> {
        const headers: Record<string, string> = body === undefined ? { authorization } : { "content-type": "application/json", authorization };
        const result = await apiFetchValidated(`${base}${path}`, schema, {
            ...policy,
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (result.isOk()) return result.value;
        const refusal = refusalOf(result.error, notFoundField);
        if (refusal) return refusal;
        return { match: "unavailable", reason: describeApiError(result.error) };
    }

    /** A contract lookup carries no pin, thus a mismatch cannot come back; the type says so. */
    async function lookup<S extends z.ZodType>(path: string, schema: S, notFoundField: string): Promise<z.infer<S> | KnowledgeUnavailable | KnowledgeRejected> {
        const answer = await call("GET", path, undefined, schema, notFoundField);
        // A GET without a body has no pin, thus a 409 is not among its answers; the guard keeps the type honest.
        if (typeof answer === "object" && answer !== null && "match" in answer && answer.match === "snapshot_mismatch") {
            return { match: "unavailable", reason: answer.message };
        }
        return answer as z.infer<S> | KnowledgeUnavailable | KnowledgeRejected;
    }

    return {
        recommend: (situation, responseFormat, preferences, expectedSnapshot) =>
            call(
                "POST",
                "/v1/recommend",
                {
                    situation,
                    ...(responseFormat ? { response_format: responseFormat } : {}),
                    ...(preferences ? { preferences } : {}),
                    ...(expectedSnapshot ? { expected_snapshot: expectedSnapshot } : {}),
                },
                RecommendResponseSchema,
            ),
        check: (situation, steps, expectedSnapshot) =>
            call("POST", "/v1/check", { situation, steps, ...(expectedSnapshot ? { expected_snapshot: expectedSnapshot } : {}) }, CheckResponseSchema),
        render: (template, slots, farm, options) =>
            call(
                "POST",
                "/v1/template/render",
                {
                    template,
                    slots,
                    ...(farm ? { farm } : {}),
                    ...(options?.step ? { step: options.step } : {}),
                    ...(options?.claims ? { claims: options.claims } : {}),
                    ...(options?.expectedSnapshot ? { expected_snapshot: options.expectedSnapshot } : {}),
                },
                RenderResponseSchema,
            ),
        contract: (template) => lookup(`/v1/templates/${encodeURIComponent(templateIdOf(template))}`, TemplateContractSchema, "template"),
    };
}
