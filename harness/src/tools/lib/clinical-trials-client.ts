/**
 * Pure async client functions for the ClinicalTrials.gov v2 API.
 *
 * Used by target-assessment workflow steps for §2.5 (clinical record),
 * §2.6.3 (trial AEs), §2.5 (failed trials), and §6.5 (discovery trials).
 */

import { z } from "zod";

import { withHost } from "../../lib/host-concurrency.js";
import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { CT_BASE, CT_HEADERS } from "./clinicaltrials-config.js";

export interface ClinicalTrial {
    nctId: string;
    title: string;
    officialTitle: string | null;
    status: string;
    phase: string | null;
    studyType: string | null;
    primaryPurpose: string | null;
    conditions: string[];
    interventions: string[];
    interventionDetails: ClinicalTrialIntervention[];
    enrollmentCount: number | null;
    startDate: string | null;
    primaryCompletionDate: string | null;
    whyStopped: string | null;
    briefSummary: string | null;
    detailedDescription: string | null;
    sponsor: string | null;
}

export interface ClinicalTrialIntervention {
    name: string;
    type: string | null;
    description: string | null;
    otherNames: string[];
}

export type OutcomeEffect =
    | { kind: "quantitative"; value: number; units: string; ci_low?: number; ci_high?: number }
    | { kind: "not_extracted"; reason: "ctgov_no_numeric_result" | "ctgov_no_result_groups" };

export interface OutcomeMeasure {
    type: "primary" | "secondary" | "other";
    measure: string;
    description: string | null;
    timeFrame: string | null;
    effect: OutcomeEffect;
}

export interface AdverseEventGroup {
    groupId: string;
    title: string;
    description: string | null;
}

export interface AdverseEventCount {
    groupId: string;
    numAffected: number | null;
    numAtRisk: number | null;
}

export interface AdverseEvent {
    serious: boolean;
    term: string;
    organSystem: string | null;
    counts: AdverseEventCount[];
}

export interface TrialDetails {
    trial: ClinicalTrial;
    whyStopped: string | null;
    outcomes: OutcomeMeasure[];
    adverseEventGroups: AdverseEventGroup[];
    adverseEvents: AdverseEvent[];
}

export interface SearchOptions {
    phase?: "EARLY_PHASE1" | "PHASE1" | "PHASE2" | "PHASE3" | "PHASE4";
    status?: "RECRUITING" | "ACTIVE_NOT_RECRUITING" | "COMPLETED" | "NOT_YET_RECRUITING" | "TERMINATED" | "WITHDRAWN" | "SUSPENDED";
    limit?: number;
}

// Raw shapes for the ClinicalTrials.gov v2 study JSON, validated at the fetch
// boundary — only the fields the mappers below read are modelled; every field
// is optional (the API omits modules that carry no data), so a partial-but-
// valid study still parses. `z.infer` supplies the types the mappers annotate.
const CtInterventionSchema = z.object({
    name: z.string().optional(),
    type: z.string().optional(),
    description: z.string().optional(),
    otherNames: z.unknown().optional(),
});
const CtOutcomeSchema = z.object({
    measure: z.string().optional(),
    description: z.string().optional(),
    timeFrame: z.string().optional(),
});
const CtIdentificationModuleSchema = z.object({
    nctId: z.string().optional(),
    briefTitle: z.string().optional(),
    officialTitle: z.string().optional(),
});
type CtIdentificationModule = z.infer<typeof CtIdentificationModuleSchema>;
const CtStatusModuleSchema = z.object({
    overallStatus: z.string().optional(),
    whyStopped: z.string().optional(),
    startDateStruct: z.object({ date: z.string().optional() }).optional(),
    primaryCompletionDateStruct: z.object({ date: z.string().optional() }).optional(),
});
type CtStatusModule = z.infer<typeof CtStatusModuleSchema>;
const CtDesignModuleSchema = z.object({
    phases: z.array(z.string()).optional(),
    studyType: z.string().optional(),
    designInfo: z.object({ primaryPurpose: z.string().optional() }).optional(),
    enrollmentInfo: z.object({ count: z.number().optional() }).optional(),
});
type CtDesignModule = z.infer<typeof CtDesignModuleSchema>;
const CtDescriptionModuleSchema = z.object({
    briefSummary: z.string().optional(),
    detailedDescription: z.string().optional(),
});
type CtDescriptionModule = z.infer<typeof CtDescriptionModuleSchema>;
const CtOutcomesModuleSchema = z.object({
    primaryOutcomes: z.array(CtOutcomeSchema).optional(),
    secondaryOutcomes: z.array(CtOutcomeSchema).optional(),
    otherOutcomes: z.array(CtOutcomeSchema).optional(),
});
type CtOutcomesModule = z.infer<typeof CtOutcomesModuleSchema>;
const CtProtocolSectionSchema = z.object({
    identificationModule: CtIdentificationModuleSchema.optional(),
    statusModule: CtStatusModuleSchema.optional(),
    designModule: CtDesignModuleSchema.optional(),
    descriptionModule: CtDescriptionModuleSchema.optional(),
    conditionsModule: z.object({ conditions: z.array(z.string()).optional() }).optional(),
    armsInterventionsModule: z.object({ interventions: z.array(CtInterventionSchema).optional() }).optional(),
    sponsorCollaboratorsModule: z.object({ leadSponsor: z.object({ name: z.string().optional() }).optional() }).optional(),
    outcomesModule: CtOutcomesModuleSchema.optional(),
});
type CtProtocolSection = z.infer<typeof CtProtocolSectionSchema>;
const CtResultsMeasurementSchema = z.object({
    value: z.string().optional(),
    lowerLimit: z.string().optional(),
    upperLimit: z.string().optional(),
});
const CtResultsMeasureSchema = z.object({
    title: z.string().optional(),
    unitOfMeasure: z.string().optional(),
    classes: z.array(z.object({ categories: z.array(z.object({ measurements: z.array(CtResultsMeasurementSchema).optional() })).optional() })).optional(),
});
type CtResultsMeasure = z.infer<typeof CtResultsMeasureSchema>;
const CtAdverseEventGroupRawSchema = z.object({
    id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
});
const CtAdverseEventStatSchema = z.object({
    groupId: z.string().optional(),
    numAffected: z.number().optional(),
    numAtRisk: z.number().optional(),
});
const CtAdverseEventRawSchema = z.object({
    term: z.string().optional(),
    organSystem: z.string().optional(),
    stats: z.array(CtAdverseEventStatSchema).optional(),
});
type CtAdverseEventRaw = z.infer<typeof CtAdverseEventRawSchema>;
const CtAdverseEventsModuleSchema = z.object({
    eventGroups: z.array(CtAdverseEventGroupRawSchema).optional(),
    seriousEvents: z.array(CtAdverseEventRawSchema).optional(),
    otherEvents: z.array(CtAdverseEventRawSchema).optional(),
});
type CtAdverseEventsModule = z.infer<typeof CtAdverseEventsModuleSchema>;
const CtResultsSectionSchema = z.object({
    outcomeMeasuresModule: z.object({ outcomeMeasures: z.array(CtResultsMeasureSchema).optional() }).optional(),
    adverseEventsModule: CtAdverseEventsModuleSchema.optional(),
});
type CtResultsSection = z.infer<typeof CtResultsSectionSchema>;
const CtStudySchema = z.object({
    protocolSection: CtProtocolSectionSchema.optional(),
    resultsSection: CtResultsSectionSchema.optional(),
});
type CtStudy = z.infer<typeof CtStudySchema>;
const CtSearchResponseSchema = z.object({
    studies: z.array(CtStudySchema).optional(),
    totalCount: z.number().optional(),
});

const STUDY_FIELDS = [
    "NCTId",
    "BriefTitle",
    "OfficialTitle",
    "OverallStatus",
    "WhyStopped",
    "Phase",
    "StudyType",
    "DesignPrimaryPurpose",
    "Condition",
    "InterventionName",
    "InterventionType",
    "InterventionDescription",
    "InterventionOtherName",
    "EnrollmentCount",
    "StartDate",
    "PrimaryCompletionDate",
    "BriefSummary",
    "DetailedDescription",
    "LeadSponsorName",
].join(",");

export function mapClinicalTrialStudy(s: CtStudy): ClinicalTrial {
    const proto: CtProtocolSection = s.protocolSection ?? {};
    const id: CtIdentificationModule = proto.identificationModule ?? {};
    const status_: CtStatusModule = proto.statusModule ?? {};
    const design: CtDesignModule = proto.designModule ?? {};
    const description: CtDescriptionModule = proto.descriptionModule ?? {};
    const conditions = proto.conditionsModule?.conditions ?? [];
    const interventionDetails: ClinicalTrialIntervention[] = (proto.armsInterventionsModule?.interventions ?? []).map((i) => ({
        name: i.name ?? "Unknown",
        type: i.type ?? null,
        description: i.description ?? null,
        otherNames: Array.isArray(i.otherNames) ? i.otherNames : [],
    }));
    const interventions = interventionDetails.map((i) => i.name);
    const sponsor = proto.sponsorCollaboratorsModule?.leadSponsor?.name ?? null;
    return {
        nctId: id.nctId ?? "",
        title: id.briefTitle ?? "",
        officialTitle: id.officialTitle ?? null,
        status: status_.overallStatus ?? "Unknown",
        whyStopped: status_.whyStopped ?? null,
        phase: design.phases?.join("/") ?? null,
        studyType: design.studyType ?? null,
        primaryPurpose: design.designInfo?.primaryPurpose ?? null,
        conditions,
        interventions,
        interventionDetails,
        enrollmentCount: design.enrollmentInfo?.count ?? null,
        startDate: status_.startDateStruct?.date ?? null,
        primaryCompletionDate: status_.primaryCompletionDateStruct?.date ?? null,
        briefSummary: description.briefSummary ?? null,
        detailedDescription: description.detailedDescription ?? null,
        sponsor,
    };
}

export async function searchTrials(query: string, options: SearchOptions = {}): Promise<{ totalFound: number; trials: ClinicalTrial[] }> {
    const limit = options.limit ?? 20;
    const params = new URLSearchParams({
        "query.term": query,
        pageSize: String(limit),
        format: "json",
        fields: STUDY_FIELDS,
    });
    if (options.phase) params.set("filter.phase", options.phase);
    if (options.status) params.set("filter.overallStatus", options.status);

    const res = await apiFetchValidated(`${CT_BASE}/studies?${params.toString()}`, CtSearchResponseSchema, {
        headers: CT_HEADERS,
    });
    if (res.isErr()) throw new Error(describeApiError(res.error));

    const studies = res.value?.studies ?? [];
    const trials = studies.map(mapClinicalTrialStudy);
    return { totalFound: res.value?.totalCount ?? trials.length, trials };
}

/** Search trials whose intervention or condition mentions the gene/target. */
export async function searchTrialsForTarget(symbol: string, options: SearchOptions = {}): Promise<{ totalFound: number; trials: ClinicalTrial[] }> {
    return searchTrials(symbol, options);
}

/** Search terminated/withdrawn/suspended trials for a target — used for §2.5 failed trials. */
export async function searchFailedTrials(symbol: string, limit = 50): Promise<{ trials: ClinicalTrial[] }> {
    const [terminated, withdrawn, suspended] = await Promise.all([
        searchTrials(symbol, { status: "TERMINATED", limit }),
        searchTrials(symbol, { status: "WITHDRAWN", limit }),
        searchTrials(symbol, { status: "SUSPENDED", limit }),
    ]);
    const seen = new Set<string>();
    const trials: ClinicalTrial[] = [];
    for (const t of [...terminated.trials, ...withdrawn.trials, ...suspended.trials]) {
        if (t.nctId && !seen.has(t.nctId)) {
            seen.add(t.nctId);
            trials.push(t);
        }
    }
    return { trials };
}

/**
 * Search terminated/withdrawn/suspended trials whose intervention list
 * contains any of the supplied drug names. Per-drug failures are isolated
 * (one drug returning nothing or throwing does not affect the others) and
 * results are deduplicated by NCT ID. Used to supplement the gene-symbol-
 * keyed failed-trials list with terminated trials of in-class drugs whose
 * sponsor code or brand name isn't surfaced by the gene-symbol query.
 */
export async function searchFailedTrialsForDrugNames(drugNames: string[], options: { perDrugLimit?: number } = {}): Promise<{ trials: ClinicalTrial[] }> {
    if (drugNames.length === 0) return { trials: [] };
    const perDrugLimit = options.perDrugLimit ?? 25;
    const perDrug = await Promise.all(
        drugNames.map(async (name) => {
            try {
                const result = await withHost("ctgov", () => searchFailedTrials(name, perDrugLimit));
                const needle = name.toLowerCase();
                return result.trials.filter((t) => t.interventions.some((iv) => iv.toLowerCase().includes(needle)));
            } catch {
                return [];
            }
        }),
    );
    const seen = new Set<string>();
    const trials: ClinicalTrial[] = [];
    for (const t of perDrug.flat()) {
        if (t.nctId && !seen.has(t.nctId)) {
            seen.add(t.nctId);
            trials.push(t);
        }
    }
    return { trials };
}

/**
 * Extract the first numeric measurement from a results-section outcome
 * measure's classes/categories/measurements tree.
 */
function extractEffect(resultsMeasure: CtResultsMeasure | undefined): OutcomeEffect {
    const classes = resultsMeasure?.classes ?? [];
    if (classes.length === 0) {
        return { kind: "not_extracted", reason: "ctgov_no_result_groups" };
    }
    for (const cls of classes) {
        for (const cat of cls.categories ?? []) {
            for (const m of cat.measurements ?? []) {
                const num = parseFloat(m.value ?? "");
                if (!isNaN(num)) {
                    return {
                        kind: "quantitative",
                        value: num,
                        units: resultsMeasure?.unitOfMeasure ?? "",
                        ...(m.lowerLimit !== undefined && m.lowerLimit !== null && !isNaN(parseFloat(m.lowerLimit))
                            ? { ci_low: parseFloat(m.lowerLimit) }
                            : {}),
                        ...(m.upperLimit !== undefined && m.upperLimit !== null && !isNaN(parseFloat(m.upperLimit))
                            ? { ci_high: parseFloat(m.upperLimit) }
                            : {}),
                    };
                }
            }
        }
    }
    return { kind: "not_extracted", reason: "ctgov_no_numeric_result" };
}

/** Fetch full study details including outcomes and adverse events. */
export async function getTrialDetails(nctId: string): Promise<TrialDetails | null> {
    const url = `${CT_BASE}/studies/${encodeURIComponent(nctId)}?format=json`;
    const res = await apiFetchValidated(url, CtStudySchema, { headers: CT_HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return null;
        throw new Error(describeApiError(res.error));
    }

    const study = res.value;
    const trial = mapClinicalTrialStudy(study);
    const proto: CtProtocolSection = study.protocolSection ?? {};
    const results: CtResultsSection = study.resultsSection ?? {};
    const whyStopped = proto.statusModule?.whyStopped ?? null;

    // Build a title→measure map from the results section so protocol-level
    // outcomes can be matched to their numeric measurements.
    const resultsMeasures = results.outcomeMeasuresModule?.outcomeMeasures ?? [];
    const resultsByTitle = new Map<string, CtResultsMeasure>();
    for (const m of resultsMeasures) {
        if (m.title) resultsByTitle.set(m.title, m);
    }

    const outcomes: OutcomeMeasure[] = [];
    const om: CtOutcomesModule = proto.outcomesModule ?? {};
    for (const o of om.primaryOutcomes ?? []) {
        const measure = o.measure ?? "";
        outcomes.push({
            type: "primary",
            measure,
            description: o.description ?? null,
            timeFrame: o.timeFrame ?? null,
            effect: extractEffect(resultsByTitle.get(measure)),
        });
    }
    for (const o of om.secondaryOutcomes ?? []) {
        const measure = o.measure ?? "";
        outcomes.push({
            type: "secondary",
            measure,
            description: o.description ?? null,
            timeFrame: o.timeFrame ?? null,
            effect: extractEffect(resultsByTitle.get(measure)),
        });
    }
    for (const o of om.otherOutcomes ?? []) {
        const measure = o.measure ?? "";
        outcomes.push({
            type: "other",
            measure,
            description: o.description ?? null,
            timeFrame: o.timeFrame ?? null,
            effect: extractEffect(resultsByTitle.get(measure)),
        });
    }

    const aeModule: CtAdverseEventsModule = results.adverseEventsModule ?? {};
    const adverseEventGroups: AdverseEventGroup[] = (aeModule.eventGroups ?? []).map((g) => ({
        groupId: g.id ?? "",
        title: g.title ?? "",
        description: g.description ?? null,
    }));

    function mapAEs(events: CtAdverseEventRaw[], serious: boolean): AdverseEvent[] {
        return events.map((e) => ({
            serious,
            term: e.term ?? "",
            organSystem: e.organSystem ?? null,
            counts: (e.stats ?? []).map((s) => ({
                groupId: s.groupId ?? "",
                numAffected: typeof s.numAffected === "number" ? s.numAffected : null,
                numAtRisk: typeof s.numAtRisk === "number" ? s.numAtRisk : null,
            })),
        }));
    }

    const adverseEvents: AdverseEvent[] = [...mapAEs(aeModule.seriousEvents ?? [], true), ...mapAEs(aeModule.otherEvents ?? [], false)];

    return { trial, whyStopped, outcomes, adverseEventGroups, adverseEvents };
}
