/**
 * Pure async client functions for the Amass Data Platform API: RegulatoryCore
 * (the FDA and EMA authorizations, with the parsed sections of their labels,
 * reviews, SmPCs and EPARs) and PatentCore (patents).
 *
 * The schemas mirror the published OpenAPI document
 * (`https://api.amass.tech/api/doc/openapi.json`). A live key verified them on
 * 2026-09-30, and the golden fixtures under `__fixtures__/amass/` hold those
 * answers.
 *
 * Absence policy: a base field is always present, and an absent value is an
 * explicit `null` (`therapeuticIndication`, `grantDate`). A field that only an
 * `include` parameter adds (`fdaDetails`, `emaDetails`, `claims`,
 * `description`) is an omitted key when the request does not ask for it. Thus
 * a base field carries `.nullable()`, and an include field carries
 * `.nullable().optional()`. A lookup item omits `amassIds` when it carries
 * `error`, and omits `error` when it carries `amassIds`.
 *
 * A response enum is a plain string here. Amass grows those vocabularies, and
 * one unknown value would otherwise reject a whole search. The input filters
 * of the tools carry the enums of the OpenAPI document.
 *
 * Status policy: only a 404 and a lookup item with `NOT_FOUND` are an absence.
 * `isUnexpectedApiError` reads every 4xx as an absence, which would turn a
 * rejected key (401) or a refused organization (403) into "no such record".
 * Thus this client classifies each status itself.
 *
 * Every call spends credits: a search costs 5 credits for each 20 records of
 * `limit`, and a get, a lookup (whatever its item count) or a 404 costs 1.
 */

import { err, ok, type Result, type ResultAsync } from "neverthrow";
import { z } from "zod";

import { apiFetchValidated, describeApiError, type ApiError } from "./api-utils.js";
import { AMASS_BASE } from "./amass-config.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The error channel of the client. `invalid_input` is the one outcome that the caller can repair. */
export type AmassError =
    | { readonly type: "invalid_input"; readonly status: number; readonly message: string }
    | { readonly type: "unauthorized"; readonly message: string }
    | { readonly type: "forbidden"; readonly message: string }
    | { readonly type: "rejected"; readonly status: number | null; readonly code: string; readonly message: string }
    | { readonly type: "api"; readonly error: ApiError };

/** Render an `AmassError` as a one-line message for the model or for a throw. */
export function describeAmassError(e: AmassError): string {
    switch (e.type) {
        case "invalid_input":
            return `Amass rejected the request (HTTP ${e.status}): ${e.message}`;
        case "unauthorized":
            return `Amass rejected the API key (HTTP 401): ${e.message}. Make sure that AMASS_API_KEY is correct.`;
        case "forbidden":
            return (
                `Amass refused the request (HTTP 403): ${e.message}. ` +
                "Make sure that AMASS_API_KEY is correct and that the organization of the key has Amass credits."
            );
        case "rejected":
            return `Amass answered ${e.code}${e.status === null ? "" : ` (HTTP ${e.status})`}: ${e.message}`;
        case "api":
            return describeApiError(e.error);
    }
}

// Every error of Amass has this one shape. A 400 adds `fields`, the reason for
// each rejected parameter.
export const AmassErrorEnvelopeSchema = z.object({
    error: z.object({
        status: z.number(),
        code: z.string(),
        message: z.string(),
        fields: z.record(z.string(), z.string()).optional(),
    }),
});

/** Read the message of an Amass error body, with the per-field reasons of a 400. */
function envelopeOf(body: string): { code: string | null; message: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return { code: null, message: body || "no message" };
    }
    const envelope = AmassErrorEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) return { code: null, message: body || "no message" };
    const { code, message, fields } = envelope.data.error;
    const reasons = fields ? Object.entries(fields).map(([field, reason]) => `${field}: ${reason}`) : [];
    return { code, message: reasons.length > 0 ? `${message} (${reasons.join("; ")})` : message };
}

/**
 * Classify a failed call. A 404 is the one absence, thus it resolves to `ok(null)`.
 * A 429 that outlived the retries arrives as `exhausted`, never as `http_status`.
 */
function classify(e: ApiError): Result<null, AmassError> {
    if (e.type !== "http_status") return err({ type: "api", error: e });
    if (e.status === 404) return ok(null);
    const { code, message } = envelopeOf(e.body);
    if (e.status === 400 || e.status === 422) return err({ type: "invalid_input", status: e.status, message });
    if (e.status === 401) return err({ type: "unauthorized", message });
    if (e.status === 403) return err({ type: "forbidden", message });
    if (e.status >= 400 && e.status < 500) return err({ type: "rejected", status: e.status, code: code ?? "UNKNOWN", message });
    return err({ type: "api", error: e });
}

function amassFetch<S extends z.ZodType>(url: URL, schema: S, headers: Record<string, string>, body?: unknown): ResultAsync<z.infer<S> | null, AmassError> {
    const options =
        body === undefined ? { headers } : { method: "POST" as const, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) };
    return apiFetchValidated(url.toString(), schema, options).orElse(classify);
}

/** Append each defined value; an array repeats the parameter, which Amass reads as "match any". */
function urlOf(path: string, params: Record<string, string | number | boolean | readonly string[] | undefined>): URL {
    const url = new URL(`${AMASS_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            for (const item of value as readonly string[]) url.searchParams.append(key, item);
        } else {
            url.searchParams.append(key, String(value));
        }
    }
    return url;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export const AmassLookupResponseSchema = z.object({
    data: z.array(
        z.object({
            input: z.record(z.string(), z.string()),
            amassIds: z.array(z.string()).optional(),
            error: z.object({ code: z.string(), message: z.string() }).optional(),
        }),
    ),
});

export type LookupItem = Readonly<Record<string, string>>;

/**
 * Resolve external identifiers to Amass IDs in one lookup request. The IDs of every
 * item are merged, in order and without duplicates. An item with `NOT_FOUND`
 * contributes no ID; an item with any other error code rejects the whole lookup.
 */
function lookup(core: "regulatorycore" | "patentcore", items: readonly LookupItem[], headers: Record<string, string>): ResultAsync<string[], AmassError> {
    return amassFetch(urlOf(`/cores/${core}/records/lookup`, {}), AmassLookupResponseSchema, headers, { items }).andThen((response) => {
        const ids: string[] = [];
        for (const item of response?.data ?? []) {
            if (item.error && item.error.code !== "NOT_FOUND") {
                return err<string[], AmassError>({ type: "rejected", status: null, code: item.error.code, message: item.error.message });
            }
            for (const id of item.amassIds ?? []) {
                if (!ids.includes(id)) ids.push(id);
            }
        }
        return ok<string[], AmassError>(ids);
    });
}

// ---------------------------------------------------------------------------
// Identifier forms
// ---------------------------------------------------------------------------

const FDA_APPLICATION_PREFIXES = ["NDA", "BLA", "ANDA"] as const;

/**
 * The lookup forms of an FDA application number. Amass stores the number with its
 * prefix (`NDA021588`) and answers `NOT_FOUND` for the bare `021588`. A bare number
 * thus goes as all three prefixes, in one request at the price of one.
 */
export function fdaApplicationForms(input: string): string[] {
    const compact = input.replace(/[\s-]/g, "").toUpperCase();
    if (/^\d+$/.test(compact)) return FDA_APPLICATION_PREFIXES.map((prefix) => `${prefix}${compact}`);
    return [compact];
}

/**
 * The lookup form of an NDC. Amass stores the two-segment product NDC (`0078-0401`)
 * and answers `NOT_FOUND` for the package NDC (`0078-0401-05`).
 */
export function productNdcOf(input: string): string {
    const trimmed = input.trim();
    const segments = trimmed.split("-");
    return segments.length === 3 && segments.every((segment) => /^\d+$/.test(segment)) ? `${segments[0]}-${segments[1]}` : trimmed;
}

// ---------------------------------------------------------------------------
// RegulatoryCore
// ---------------------------------------------------------------------------

export const REGULATORY_AGENCIES = ["FDA", "EMA"] as const;
export const REGULATORY_MOLECULE_TYPES = [
    "SMALL_MOLECULE",
    "ANTIBODY",
    "PROTEIN",
    "ENZYME",
    "OLIGONUCLEOTIDE",
    "GENE",
    "CELL",
    "ANTIBODY_DRUG_CONJUGATE",
    "VACCINE_COMPONENT",
    "VACCINE",
    "OLIGOSACCHARIDE",
    "UNKNOWN",
] as const;
export const REGULATORY_AUTHORIZATION_STATUSES = [
    "ACTIVE",
    "APPROVED_NOT_MARKETED",
    "CONDITIONAL",
    "SUSPENDED",
    "WITHDRAWN_VOLUNTARY",
    "WITHDRAWN_FORCED",
    "REVOKED",
    "LAPSED_SUNSET",
    "REFUSED",
    "WITHDRAWN_DURING_REVIEW",
    "EXPIRED",
    "UNKNOWN",
] as const;
export const REGULATORY_DESIGNATIONS = [
    "PRIORITY_REVIEW",
    "BREAKTHROUGH_THERAPY",
    "FAST_TRACK",
    "RMAT",
    "ACCELERATED_APPROVAL",
    "ACCELERATED_ASSESSMENT",
    "PRIME",
    "CONDITIONAL_MA",
    "EXCEPTIONAL_CIRCUMSTANCES",
] as const;

const DocumentSectionSchema = z.object({
    documentSectionId: z.string(),
    amassId: z.string(),
    docType: z.string(),
    path: z.string().nullable(),
    title: z.string().nullable(),
    textType: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    sourceDate: z.string().nullable(),
});

const MatchedSectionSchema = DocumentSectionSchema.extend({ matchedText: z.string().nullable() });

const DesignationSchema = z.object({
    axis: z.string(),
    type: z.string(),
    agency: z.string(),
    nativeName: z.string().nullable(),
    basis: z.string().nullable(),
    indication: z.string().nullable(),
    postMarketingObligation: z.boolean().nullable(),
});

const OtherAuthorizationSchema = z.object({
    amassId: z.string(),
    agency: z.string(),
    name: z.string().nullable(),
    authorizationStatus: z.string().nullable(),
});

const FdaDetailsSchema = z.object({
    applicationNumber: z.string().nullable(),
    prescriptionClass: z.string().nullable(),
    submissionClassCode: z.string().nullable(),
    labelDate: z.string().nullable(),
    labelUrl: z.string().nullable(),
    ndc: z.array(z.string()),
    splSetId: z.array(z.string()),
    withdrawalDate: z.string().nullable(),
    withdrawalReason: z.string().nullable(),
    withdrawalSourceUrl: z.string().nullable(),
});

const EmaDetailsSchema = z.object({
    productNumber: z.string().nullable(),
    category: z.string().nullable(),
    opinionStatus: z.string().nullable(),
    isBiosimilar: z.boolean().nullable(),
    isAdvancedTherapy: z.boolean().nullable(),
    isGenericOrHybrid: z.boolean().nullable(),
    additionalMonitoring: z.boolean().nullable(),
    pharmacotherapeuticGroup: z.string().nullable(),
    patientSafety: z.string().nullable(),
    latestProcedure: z.string().nullable(),
    revisionNumber: z.number().nullable(),
    smpcUrl: z.string().nullable(),
    smpcDate: z.string().nullable(),
    opinionAdoptedDate: z.string().nullable(),
    europeanCommissionDecisionDate: z.string().nullable(),
    withdrawalOfApplicationDate: z.string().nullable(),
    refusalOfMarketingAuthorisationDate: z.string().nullable(),
    withdrawalExpiryRevocationLapseDate: z.string().nullable(),
    firstPublishedDate: z.string().nullable(),
});

const RegulatoryBaseSchema = z.object({
    amassId: z.string(),
    agency: z.string(),
    name: z.string().nullable(),
    activeSubstance: z.string().nullable(),
    moleculeType: z.string().nullable(),
    authorizationStatus: z.string().nullable(),
    procedureType: z.string().nullable(),
    therapeuticIndication: z.string().nullable(),
    marketingAuthorisationHolder: z.string().nullable(),
    authorizationDate: z.string().nullable(),
    firstAuthorizationDate: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    isOrphan: z.boolean().nullable(),
    designations: z.array(DesignationSchema),
    authorizationsByAgency: z.array(OtherAuthorizationSchema),
    fdaDetails: FdaDetailsSchema.nullable().optional(),
    emaDetails: EmaDetailsSchema.nullable().optional(),
});

export const RegulatorySearchResponseSchema = z.object({
    data: z.array(RegulatoryBaseSchema.extend({ documentSections: z.array(MatchedSectionSchema) })),
});

export const RegulatoryRecordResponseSchema = z.object({
    data: RegulatoryBaseSchema.extend({ documentSections: z.array(DocumentSectionSchema) }),
});

export const RegulatorySectionResponseSchema = z.object({
    data: DocumentSectionSchema.extend({ content: z.string().nullable() }),
});

type RegulatoryBase = z.infer<typeof RegulatoryBaseSchema>;
type DocumentSection = z.infer<typeof DocumentSectionSchema>;
type MatchedSection = z.infer<typeof MatchedSectionSchema>;

/** The sections of one source document. The document fields appear once, not on every section. */
export interface SectionGroup<S> {
    readonly docType: string;
    readonly sourceUrl: string | null;
    readonly sourceDate: string | null;
    readonly sections: S[];
}

/** One entry of a table of contents. */
export interface SectionEntry {
    readonly documentSectionId: string;
    readonly path: string | null;
    readonly title: string | null;
}

/** One matched section of a search, with the excerpt that drove the match. */
export interface MatchedSectionEntry extends SectionEntry {
    readonly matchedText: string | null;
}

/**
 * Group sections by their source document, in the order of first appearance. An
 * FDA label has a hundred sections or more, and each raw entry repeats the record
 * ID, the PDF URL and the revision date; the group states the last two once.
 */
function groupSections<T extends DocumentSection, S>(sections: readonly T[], entryOf: (section: T) => S): SectionGroup<S>[] {
    const groups = new Map<string, SectionGroup<S>>();
    for (const section of sections) {
        const key = `${section.docType}\u0000${section.sourceUrl ?? ""}\u0000${section.sourceDate ?? ""}`;
        let group = groups.get(key);
        if (!group) {
            group = { docType: section.docType, sourceUrl: section.sourceUrl, sourceDate: section.sourceDate, sections: [] };
            groups.set(key, group);
        }
        group.sections.push(entryOf(section));
    }
    return [...groups.values()];
}

/** The fields of an authorization that both the search and the details answer carry. */
export interface AuthorizationSummary {
    readonly amassId: string;
    readonly agency: string;
    readonly name: string | null;
    readonly activeSubstance: string | null;
    readonly moleculeType: string | null;
    readonly authorizationStatus: string | null;
    readonly procedureType: string | null;
    readonly therapeuticIndication: string | null;
    readonly marketingAuthorisationHolder: string | null;
    readonly authorizationDate: string | null;
    readonly firstAuthorizationDate: string | null;
    readonly isOrphan: boolean | null;
    readonly designations: RegulatoryBase["designations"];
    readonly otherAuthorizations: RegulatoryBase["authorizationsByAgency"];
    readonly sourceUrl: string | null;
}

function summaryOf(record: RegulatoryBase): AuthorizationSummary {
    return {
        amassId: record.amassId,
        agency: record.agency,
        name: record.name,
        activeSubstance: record.activeSubstance,
        moleculeType: record.moleculeType,
        authorizationStatus: record.authorizationStatus,
        procedureType: record.procedureType,
        therapeuticIndication: record.therapeuticIndication,
        marketingAuthorisationHolder: record.marketingAuthorisationHolder,
        authorizationDate: record.authorizationDate,
        firstAuthorizationDate: record.firstAuthorizationDate,
        isOrphan: record.isOrphan,
        designations: record.designations,
        otherAuthorizations: record.authorizationsByAgency,
        sourceUrl: record.sourceUrl,
    };
}

/** The matched sections that a search row keeps. The count still reports all of them. */
export const MAX_MATCHED_SECTIONS = 5;

export interface AuthorizationSearchRow extends AuthorizationSummary {
    readonly matchedSectionCount: number;
    readonly matchedDocuments: SectionGroup<MatchedSectionEntry>[];
}

export function mapRegulatorySearchRow(record: z.infer<typeof RegulatorySearchResponseSchema>["data"][number]): AuthorizationSearchRow {
    return {
        ...summaryOf(record),
        matchedSectionCount: record.documentSections.length,
        matchedDocuments: groupSections(record.documentSections.slice(0, MAX_MATCHED_SECTIONS), (section: MatchedSection) => ({
            documentSectionId: section.documentSectionId,
            path: section.path,
            title: section.title,
            matchedText: section.matchedText,
        })),
    };
}

export interface AuthorizationRecord extends AuthorizationSummary {
    readonly fdaDetails: z.infer<typeof FdaDetailsSchema> | null;
    readonly emaDetails: z.infer<typeof EmaDetailsSchema> | null;
    readonly sectionCount: number;
    readonly documents: SectionGroup<SectionEntry>[];
}

export function mapRegulatoryRecord(record: z.infer<typeof RegulatoryRecordResponseSchema>["data"]): AuthorizationRecord {
    return {
        ...summaryOf(record),
        fdaDetails: record.fdaDetails ?? null,
        emaDetails: record.emaDetails ?? null,
        sectionCount: record.documentSections.length,
        documents: groupSections(record.documentSections, (section) => ({
            documentSectionId: section.documentSectionId,
            path: section.path,
            title: section.title,
        })),
    };
}

export interface RegulatorySection {
    readonly amassId: string;
    readonly documentSectionId: string;
    readonly docType: string;
    readonly path: string | null;
    readonly title: string | null;
    readonly sourceUrl: string | null;
    readonly sourceDate: string | null;
    readonly content: string | null;
}

export interface RegulatorySearchParams {
    readonly query: string;
    readonly limit: number;
    readonly agency?: readonly string[];
    readonly authorizationStatus?: readonly string[];
    readonly moleculeType?: readonly string[];
    readonly hasDesignation?: readonly string[];
    readonly isOrphan?: boolean;
    readonly minAuthorizationDate?: string;
    readonly maxAuthorizationDate?: string;
    readonly amassId?: string;
}

export function searchRegulatoryRecords(params: RegulatorySearchParams, headers: Record<string, string>): ResultAsync<AuthorizationSearchRow[], AmassError> {
    const url = urlOf("/cores/regulatorycore/records", { ...params });
    return amassFetch(url, RegulatorySearchResponseSchema, headers).map((response) => (response?.data ?? []).map(mapRegulatorySearchRow));
}

/** One authorization with its table of contents, or `null` when Amass holds no such ID. */
export function getRegulatoryRecord(amassId: string, headers: Record<string, string>): ResultAsync<AuthorizationRecord | null, AmassError> {
    const url = urlOf(`/cores/regulatorycore/records/${encodeURIComponent(amassId)}`, { include: ["fdaDetails", "emaDetails"] });
    return amassFetch(url, RegulatoryRecordResponseSchema, headers).map((response) => (response ? mapRegulatoryRecord(response.data) : null));
}

/** The full text of one document section, or `null` when Amass holds no such section. */
export function getRegulatorySection(
    amassId: string,
    documentSectionId: string,
    headers: Record<string, string>,
): ResultAsync<RegulatorySection | null, AmassError> {
    const url = urlOf(`/cores/regulatorycore/records/${encodeURIComponent(amassId)}/document-sections/${encodeURIComponent(documentSectionId)}`, {});
    return amassFetch(url, RegulatorySectionResponseSchema, headers).map((response) => {
        if (!response) return null;
        const { textType: _textType, ...section } = response.data;
        return section;
    });
}

/** The identifiers that the RegulatoryCore lookup accepts. Exactly one is set. */
export interface RegulatoryIdentifier {
    readonly fdaApplicationNumber?: string;
    readonly emaProductNumber?: string;
    readonly ndc?: string;
    readonly splSetId?: string;
}

export function regulatoryLookupItems(id: RegulatoryIdentifier): LookupItem[] {
    if (id.fdaApplicationNumber !== undefined) return fdaApplicationForms(id.fdaApplicationNumber).map((form) => ({ fdaApplicationNumber: form }));
    if (id.ndc !== undefined) return [{ ndc: productNdcOf(id.ndc) }];
    if (id.emaProductNumber !== undefined) return [{ emaProductNumber: id.emaProductNumber.trim() }];
    if (id.splSetId !== undefined) return [{ splSetId: id.splSetId.trim() }];
    return [];
}

export function lookupRegulatoryIds(id: RegulatoryIdentifier, headers: Record<string, string>): ResultAsync<string[], AmassError> {
    return lookup("regulatorycore", regulatoryLookupItems(id), headers);
}

// ---------------------------------------------------------------------------
// PatentCore
// ---------------------------------------------------------------------------

const PatentBaseSchema = z.object({
    amassId: z.string(),
    publicationNumber: z.string().nullable(),
    url: z.string().nullable(),
    applicationNumber: z.string().nullable(),
    countryCode: z.string().nullable(),
    kindCode: z.string().nullable(),
    familyId: z.string().nullable(),
    familyMembers: z.array(z.string()),
    title: z.string().nullable(),
    abstract: z.string().nullable(),
    language: z.string().nullable(),
    nonEnglishFallback: z.boolean().nullable(),
    cpcCodes: z.array(z.string()),
    inventors: z.array(z.string()),
    assignees: z.array(z.string()),
    publicationDate: z.string().nullable(),
    filingDate: z.string().nullable(),
    grantDate: z.string().nullable(),
    priorityDate: z.string().nullable(),
    citedPatents: z.array(z.string()),
    hasClaims: z.boolean().nullable(),
    hasDescription: z.boolean().nullable(),
    nplCount: z.number().nullable(),
    citedByCount: z.number().nullable(),
    claims: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
});

export const PatentSearchResponseSchema = z.object({ data: z.array(PatentBaseSchema) });
export const PatentRecordResponseSchema = z.object({ data: PatentBaseSchema });

type PatentBase = z.infer<typeof PatentBaseSchema>;

/** A patent with its citation counts. The citation lists stay out: a cited patent can carry thousands. */
export interface PatentSummary {
    readonly amassId: string;
    readonly publicationNumber: string | null;
    readonly applicationNumber: string | null;
    readonly countryCode: string | null;
    readonly kindCode: string | null;
    readonly familyId: string | null;
    readonly familyMemberCount: number;
    readonly title: string | null;
    readonly abstract: string | null;
    readonly assignees: string[];
    readonly inventors: string[];
    readonly cpcCodes: string[];
    readonly publicationDate: string | null;
    readonly filingDate: string | null;
    readonly grantDate: string | null;
    readonly priorityDate: string | null;
    readonly citedPatentCount: number;
    readonly citedByCount: number | null;
    readonly nplCount: number | null;
    readonly hasClaims: boolean | null;
    readonly hasDescription: boolean | null;
    readonly url: string | null;
}

export function mapPatentSummary(record: PatentBase): PatentSummary {
    return {
        amassId: record.amassId,
        publicationNumber: record.publicationNumber,
        applicationNumber: record.applicationNumber,
        countryCode: record.countryCode,
        kindCode: record.kindCode,
        familyId: record.familyId,
        familyMemberCount: record.familyMembers.length,
        title: record.title,
        abstract: record.abstract,
        assignees: record.assignees,
        inventors: record.inventors,
        cpcCodes: record.cpcCodes,
        publicationDate: record.publicationDate,
        filingDate: record.filingDate,
        grantDate: record.grantDate,
        priorityDate: record.priorityDate,
        citedPatentCount: record.citedPatents.length,
        citedByCount: record.citedByCount,
        nplCount: record.nplCount,
        hasClaims: record.hasClaims,
        hasDescription: record.hasDescription,
        url: record.url,
    };
}

export interface PatentRecord extends PatentSummary {
    readonly familyMembers: string[];
    readonly language: string | null;
    readonly nonEnglishFallback: boolean | null;
    readonly claims?: string | null;
    readonly description?: string | null;
}

export function mapPatentRecord(record: PatentBase): PatentRecord {
    return {
        ...mapPatentSummary(record),
        familyMembers: record.familyMembers,
        language: record.language,
        nonEnglishFallback: record.nonEnglishFallback,
        ...(record.claims === undefined ? {} : { claims: record.claims }),
        ...(record.description === undefined ? {} : { description: record.description }),
    };
}

export interface PatentSearchParams {
    readonly query: string;
    readonly limit: number;
    readonly assignee?: readonly string[];
    readonly inventor?: string;
    readonly cpcCodes?: readonly string[];
    readonly countryCode?: readonly string[];
    readonly minPublicationDate?: string;
    readonly maxPublicationDate?: string;
    readonly minFilingDate?: string;
    readonly maxFilingDate?: string;
    readonly minPriorityDate?: string;
    readonly maxPriorityDate?: string;
    readonly minGrantDate?: string;
    readonly maxGrantDate?: string;
}

/** PatentCore reads a list filter as one comma-separated value, not as a repeated parameter. */
function commaList(values: readonly string[] | undefined): string | undefined {
    return values && values.length > 0 ? values.join(",") : undefined;
}

export function searchPatentRecords(params: PatentSearchParams, headers: Record<string, string>): ResultAsync<PatentSummary[], AmassError> {
    const url = urlOf("/cores/patentcore/records", {
        ...params,
        assignee: commaList(params.assignee),
        cpcCodes: commaList(params.cpcCodes),
        countryCode: commaList(params.countryCode),
    });
    return amassFetch(url, PatentSearchResponseSchema, headers).map((response) => (response?.data ?? []).map(mapPatentSummary));
}

export function getPatentRecord(
    amassId: string,
    include: { readonly claims: boolean; readonly description: boolean },
    headers: Record<string, string>,
): ResultAsync<PatentRecord | null, AmassError> {
    const includes = [...(include.claims ? ["claims"] : []), ...(include.description ? ["description"] : [])];
    const url = urlOf(`/cores/patentcore/records/${encodeURIComponent(amassId)}`, { include: includes });
    return amassFetch(url, PatentRecordResponseSchema, headers).map((response) => (response ? mapPatentRecord(response.data) : null));
}

/** The identifiers that the PatentCore lookup accepts. Exactly one is set. */
export interface PatentIdentifier {
    readonly publicationNumber?: string;
    readonly applicationNumber?: string;
}

export function lookupPatentIds(id: PatentIdentifier, headers: Record<string, string>): ResultAsync<string[], AmassError> {
    const items: LookupItem[] =
        id.publicationNumber !== undefined
            ? [{ publicationNumber: id.publicationNumber.trim() }]
            : id.applicationNumber !== undefined
              ? [{ applicationNumber: id.applicationNumber.trim() }]
              : [];
    return lookup("patentcore", items, headers);
}
