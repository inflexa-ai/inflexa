import { z } from "zod";

export const CitationKindSchema = z.enum(["doi", "pmid", "arxiv", "free_text", "auto"]);
export type CitationKind = z.infer<typeof CitationKindSchema>;

export const CitationInputSchema = z.object({
    citation: z.string().trim().min(1).max(5_000),
    kind: CitationKindSchema.optional(),
    title: z.string().trim().min(1).max(2_000).optional(),
    authors: z.array(z.string().trim().min(1).max(500)).max(500).optional(),
    year: z.number().int().min(1000).max(3000).optional(),
    venue: z.string().trim().min(1).max(1_000).optional(),
    volume: z.string().trim().min(1).max(100).optional(),
    firstPage: z.string().trim().min(1).max(100).optional(),
});
export type CitationInput = z.infer<typeof CitationInputSchema>;

export const CitationSourceSchema = z.enum(["doi_registry", "crossref", "pubmed", "arxiv", "semantic_scholar"]);
export type CitationSource = z.infer<typeof CitationSourceSchema>;

export const CitationSourceStatusSchema = z.enum(["ok", "no_data", "unavailable", "not_applicable"]);
export type CitationSourceStatus = z.infer<typeof CitationSourceStatusSchema>;

export const CitationVerdictSchema = z.enum(["verified", "metadata_mismatch", "not_found", "unverifiable", "inconclusive"]);
export type CitationVerdict = z.infer<typeof CitationVerdictSchema>;

export const CitationCoverageSchema = z.enum(["complete", "partial", "none"]);
export type CitationCoverage = z.infer<typeof CitationCoverageSchema>;

export const ComparisonStatusSchema = z.enum(["match", "mismatch", "not_compared"]);
export type ComparisonStatus = z.infer<typeof ComparisonStatusSchema>;

export const CitationFieldSchema = z.enum(["title", "authors", "year", "venue", "volume", "firstPage"]);
export type CitationField = z.infer<typeof CitationFieldSchema>;

export const UnsupportedWorkKindSchema = z.enum(["personal_communication", "unpublished", "unregistered_in_press"]);
export type UnsupportedWorkKind = z.infer<typeof UnsupportedWorkKindSchema>;

export const CitationIdentifiersSchema = z.object({
    doi: z.string().optional(),
    pmid: z.string().optional(),
    arxiv: z.string().optional(),
    corpusId: z.string().optional(),
});
export type CitationIdentifiers = z.infer<typeof CitationIdentifiersSchema>;

export const NormalizedCitationMetadataSchema = z.object({
    title: z.string().optional(),
    authors: z.array(z.string()).optional(),
    year: z.number().int().optional(),
    venue: z.string().optional(),
    volume: z.string().optional(),
    firstPage: z.string().optional(),
});
export type NormalizedCitationMetadata = z.infer<typeof NormalizedCitationMetadataSchema>;

export const NormalizedCitationSchema = z.object({
    citation: z.string(),
    query: z.string(),
    kind: z.enum(["doi", "pmid", "arxiv", "free_text"]),
    identifiers: CitationIdentifiersSchema,
    supplied: NormalizedCitationMetadataSchema,
    unsupportedWorkKind: UnsupportedWorkKindSchema.optional(),
});
export type NormalizedCitation = z.infer<typeof NormalizedCitationSchema>;

export const CitationRecordSchema = z.object({
    source: CitationSourceSchema,
    sourceRecordId: z.string(),
    identifiers: CitationIdentifiersSchema,
    title: z.string().optional(),
    authors: z.array(z.string()).optional(),
    year: z.number().int().optional(),
    venue: z.string().optional(),
    volume: z.string().optional(),
    firstPage: z.string().optional(),
    registrationAgency: z.string().optional(),
    url: z.string().optional(),
});
export type CitationRecord = z.infer<typeof CitationRecordSchema>;

export const IdentifierEvidenceSchema = z.object({
    type: z.enum(["doi", "pmid", "arxiv"]),
    identifier: z.string(),
    exists: z.boolean(),
    registrationAgency: z.string().optional(),
    metadataAvailable: z.boolean(),
});
export type IdentifierEvidence = z.infer<typeof IdentifierEvidenceSchema>;

export const CitationSourceOutcomeSchema = z.object({
    source: CitationSourceSchema,
    operation: z.string(),
    status: CitationSourceStatusSchema,
    requestCount: z.number().int().nonnegative(),
    records: z.array(CitationRecordSchema),
    detail: z.string().optional(),
    identifierEvidence: IdentifierEvidenceSchema.optional(),
});
export type CitationSourceOutcome = z.infer<typeof CitationSourceOutcomeSchema>;

export const CitationFieldComparisonSchema = z.object({
    field: CitationFieldSchema,
    status: ComparisonStatusSchema,
    supplied: z.union([z.string(), z.number(), z.array(z.string())]),
    sourceValues: z.array(
        z.object({
            source: CitationSourceSchema,
            value: z.union([z.string(), z.number(), z.array(z.string())]),
        }),
    ),
    ruleVersion: z.string(),
});
export type CitationFieldComparison = z.infer<typeof CitationFieldComparisonSchema>;

export const CitationConflictSchema = z.object({
    field: CitationFieldSchema,
    values: z.array(
        z.object({
            source: CitationSourceSchema,
            value: z.union([z.string(), z.number(), z.array(z.string())]),
        }),
    ),
});
export type CitationConflict = z.infer<typeof CitationConflictSchema>;

export const CitationClusterRelationSchema = z.object({
    clusterId: z.string(),
    kind: z.enum(["preprint_of", "published_as", "related_version"]),
});

export const CitationCandidateClusterSchema = z.object({
    id: z.string(),
    score: z.number().min(0).max(1),
    records: z.array(CitationRecordSchema).min(1),
    relations: z.array(CitationClusterRelationSchema),
});
export type CitationCandidateCluster = z.infer<typeof CitationCandidateClusterSchema>;

export const CitationResolutionResultSchema = z.object({
    input: CitationInputSchema,
    normalized: NormalizedCitationSchema,
    sourceOutcomes: z.array(CitationSourceOutcomeSchema),
    candidates: z.array(CitationCandidateClusterSchema),
    selectedClusterId: z.string().optional(),
    comparisons: z.array(CitationFieldComparisonSchema),
    conflicts: z.array(CitationConflictSchema),
    verdict: CitationVerdictSchema,
    coverage: CitationCoverageSchema,
});
export type CitationResolutionResult = z.infer<typeof CitationResolutionResultSchema>;

export interface CitationResolveOptions {
    readonly signal?: AbortSignal;
}

export interface CitationResolver {
    resolveOne(input: CitationInput, options?: CitationResolveOptions): Promise<CitationResolutionResult>;
    resolveMany(inputs: readonly CitationInput[], options?: CitationResolveOptions): Promise<CitationResolutionResult[]>;
}

export const CitationSourceOperationSchema = z.enum([
    "doi_exact",
    "crossref_doi_if_owned",
    "crossref_bibliographic",
    "pubmed_exact",
    "pubmed_doi",
    "pubmed_structured",
    "pubmed_title",
    "arxiv_exact",
    "arxiv_bibliographic",
    "semantic_scholar_identifier",
    "semantic_scholar_bibliographic",
    "none",
]);
export type CitationSourceOperation = z.infer<typeof CitationSourceOperationSchema>;

export const CitationSourcePlanItemSchema = z.object({
    source: CitationSourceSchema,
    applicable: z.boolean(),
    operation: CitationSourceOperationSchema,
    candidateGeneration: z.boolean(),
    reason: z.string(),
});
export type CitationSourcePlanItem = z.infer<typeof CitationSourcePlanItemSchema>;

export interface CitationSourceRequest {
    readonly input: CitationInput;
    readonly normalized: NormalizedCitation;
    readonly plan: CitationSourcePlanItem;
    readonly registrationAgency?: string;
}

export interface CitationSourceClient {
    readonly source: CitationSource;
    resolve(request: CitationSourceRequest, signal?: AbortSignal): Promise<CitationSourceOutcome>;
    resolveMany?(requests: readonly CitationSourceRequest[], signal?: AbortSignal): Promise<CitationSourceOutcome[]>;
}
