import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { ORGAN_SYSTEMS } from "./organ-system.js";
import {
    ClaimEvidenceSchema,
    ClaimInvestigationSchema,
    ClaimSupportSchema,
    ClaimVerdictSchema,
    CoverageSchema,
    DossierSchema,
    InvestigatedClaimRowSchema,
    RowCoverageSchema,
    SafetyFlagSchema,
    SafetyProfileSchema,
} from "./target-dossier.js";

/**
 * Dotted paths whose content does not depend on an enrichment source, and so
 * carry no coverage envelope: identity, timestamps, values derived from other
 * sections, and the shipped benchmark table.
 *
 * The walk below classifies every other node in the dossier as either an
 * envelope or a container of them, so a section that is neither has to be
 * named here. That is the point: a new section reaches the dossier only once
 * someone has decided which group it belongs to.
 */
const NON_ENRICHMENT_PATHS = new Set([
    "entity",
    "generated_at",
    "liability_summary",
    "derived",
    "clinical_development.benchmarks",
    "reference_biology.preclinical.data_coverage",
]);

/**
 * Probes that hold for the shared coverage envelope and for nothing else.
 *
 * Asking only whether `{coverage: "not_loaded"}` parses proves nothing — any
 * object whose fields are all optional accepts it. These pin the whole
 * discriminator: each of the four states with the payload it owes, the
 * rejection of a state outside the vocabulary, and the rejection of a branch
 * missing its required payload.
 */
const ENVELOPE_PROBES: ReadonlyArray<{ readonly value: unknown; readonly accepted: boolean; readonly proves: string }> = [
    { value: { coverage: "not_loaded" }, accepted: true, proves: "not_loaded needs nothing beyond the state" },
    { value: { coverage: "queried_no_data" }, accepted: true, proves: "queried_no_data needs nothing beyond the state" },
    { value: { coverage: "filtered", filter: "below the floor", dropped_count: 3 }, accepted: true, proves: "filtered carries its filter and count" },
    { value: { coverage: "filtered", dropped_count: 3 }, accepted: false, proves: "filtered without a filter is rejected" },
    { value: { coverage: "filtered", filter: "below the floor" }, accepted: false, proves: "filtered without a count is rejected" },
    { value: { coverage: "available" }, accepted: false, proves: "available without data is rejected" },
    { value: { coverage: "partially_loaded" }, accepted: false, proves: "a state outside the vocabulary is rejected" },
    { value: {}, accepted: false, proves: "a value carrying no state at all is rejected" },
];

function isCoverageEnvelope(schema: z.ZodType): boolean {
    return ENVELOPE_PROBES.every((probe) => schema.safeParse(probe.value).success === probe.accepted);
}

/** Collect `[path, schema]` for every node the walk decides must be an envelope. */
function envelopePaths(path: string, schema: z.ZodType, out: Array<[string, z.ZodType]>): void {
    if (NON_ENRICHMENT_PATHS.has(path)) return;
    const inner = schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema;
    if (inner instanceof z.ZodObject) {
        for (const [key, child] of Object.entries(inner.shape as Record<string, z.ZodType>)) {
            envelopePaths(path === "" ? key : `${path}.${key}`, child, out);
        }
        return;
    }
    out.push([path, inner]);
}

describe("coverage discipline", () => {
    test("carries exactly the four states, with the original three unchanged", () => {
        expect(new Set(CoverageSchema.options)).toEqual(new Set(["available", "queried_no_data", "not_loaded", "filtered"]));
    });

    test("a row marker cannot be filtered", () => {
        expect(RowCoverageSchema.safeParse("filtered").success).toBe(false);
        expect(RowCoverageSchema.safeParse("queried_no_data").success).toBe(true);
    });

    test("every dossier section, at every depth, is an envelope or a deliberate exemption", () => {
        const found: Array<[string, z.ZodType]> = [];
        envelopePaths("", DossierSchema as unknown as z.ZodType, found);

        // The walk descends through containers, so it must reach nested
        // sections and not only the top level.
        expect(found.map(([path]) => path)).toContain("reference_biology.preclinical.ko_phenotype");

        const unenveloped = found.filter(([, schema]) => !isCoverageEnvelope(schema)).map(([path]) => path);
        expect(unenveloped).toEqual([]);
    });

    test("each probe is what makes the envelope check bite", () => {
        const section = SafetyProfileSchema.shape.organ_rollup;
        for (const probe of ENVELOPE_PROBES) {
            expect({ proves: probe.proves, accepted: section.safeParse(probe.value).success }).toEqual({ proves: probe.proves, accepted: probe.accepted });
        }
    });

    test("a bare optional-field object is not mistaken for an envelope", () => {
        expect(isCoverageEnvelope(z.object({ coverage: z.string().optional(), data: z.unknown().optional() }))).toBe(false);
    });

    test("a partially filtered section reports its own drops", () => {
        const section = SafetyProfileSchema.shape.organ_rollup;
        expect(section.safeParse({ coverage: "available", data: { rows: [] }, dropped_count: 3 }).success).toBe(true);
    });
});

describe("failed-trial attribution", () => {
    const failedTrial = (nctId: string, attributed: boolean) => ({
        nct_id: nctId,
        title: "A terminated study",
        why_stopped: "sponsor decision",
        classifier: "rules",
        failure_category: { category: "strategic", category_evidence_excerpt: "sponsor decision" },
        attribution: attributed
            ? { relationship: "class_modulator", evidence_role: "supports_target", basis: [{ kind: "known_class_drug", source: "chembl" }] }
            : {
                  relationship: "related_family_target",
                  evidence_role: "excluded",
                  basis: [{ kind: "related_family_target", source: "chembl" }],
                  exclusion_reason: "Intervention targets a related family receptor, not the assessed target.",
              },
        eligible_for_toxicology_aggregation: attributed,
    });

    test("the safety lens partitions related-receptor trials the same way clinical development does", () => {
        const data = { rows: [failedTrial("NCT001", true)], excluded_rows: [failedTrial("NCT002", false)] };
        const section = { coverage: "available", data };

        // Both sections carry the same two buckets, so a reader of either can
        // tell a target-attributed termination from a related-receptor one.
        expect(SafetyProfileSchema.shape.failed_trials_safety_lens.safeParse(section).success).toBe(true);
        expect(DossierSchema.shape.clinical_development.shape.failed_trials.safeParse(section).success).toBe(true);
    });

    test("a related-receptor trial can never claim to support the target", () => {
        const contradiction = {
            ...failedTrial("NCT002", false),
            attribution: {
                relationship: "related_family_target",
                evidence_role: "supports_target",
                basis: [{ kind: "related_family_target", source: "chembl" }],
            },
        };
        expect(SafetyProfileSchema.shape.failed_trials_safety_lens.safeParse({ coverage: "available", data: { rows: [contradiction] } }).success).toBe(false);
    });
});

describe("claim evidence", () => {
    const locator = { source: "open targets", pmid: "12345678" };

    test("a scored claim with no evidence cannot be constructed", () => {
        expect(ClaimSupportSchema.safeParse({ state: "scored", evidence: [] }).success).toBe(false);
        expect(ClaimSupportSchema.safeParse({ state: "scored" }).success).toBe(false);
    });

    test("a scored claim with evidence parses", () => {
        expect(ClaimSupportSchema.safeParse({ state: "scored", evidence: [locator] }).success).toBe(true);
    });

    test("unknown is a complete outcome, carrying only a reason", () => {
        expect(ClaimSupportSchema.safeParse({ state: "unknown", reason: "no citable per-tissue record" }).success).toBe(true);
        expect(ClaimSupportSchema.safeParse({ state: "unknown", reason: "" }).success).toBe(false);
    });

    test("evidence naming only a source does not resolve", () => {
        expect(ClaimEvidenceSchema.safeParse({ source: "open targets" }).success).toBe(false);
    });

    test("any one locator resolves", () => {
        for (const l of [{ pmid: "1" }, { doi: "10.1/x" }, { accession: "ENSG00000141510" }, { regulatory_reference: { document: "NDA 021436" } }]) {
            expect(ClaimEvidenceSchema.safeParse({ source: "s", ...l }).success).toBe(true);
        }
    });
});

describe("claim investigation", () => {
    const row = {
        organ: "hepatic",
        mechanism: { statement: "bile-salt export pump inhibition", support: { state: "unknown", reason: "no citable record" } },
        critique: { objection: "both sources trace to one curation", support: { state: "unknown", reason: "nothing retrieved" } },
        verdict: "weakened",
        rounds_run: 1,
        convergence: "verdict_settled",
        support: { state: "scored", evidence: [{ source: "pubmed", pmid: "12345678" }] },
    };

    test("the verdict vocabulary is closed and carries no numeric grade", () => {
        expect(new Set(ClaimVerdictSchema.options)).toEqual(new Set(["upheld", "weakened", "overturned", "undetermined"]));
        expect(ClaimVerdictSchema.safeParse(0.8).success).toBe(false);
    });

    test("a row parses, and a numeric soundness field is not part of it", () => {
        expect(InvestigatedClaimRowSchema.safeParse(row).success).toBe(true);
        const parsed = InvestigatedClaimRowSchema.parse({ ...row, soundness: 0.8 }) as Record<string, unknown>;
        expect("soundness" in parsed).toBe(false);
    });

    test("a row with no mechanism and no critique still carries its verdict", () => {
        expect(InvestigatedClaimRowSchema.safeParse({ ...row, mechanism: null, critique: null }).success).toBe(true);
    });

    test("a verdict cannot be scored without evidence", () => {
        expect(InvestigatedClaimRowSchema.safeParse({ ...row, support: { state: "scored", evidence: [] } }).success).toBe(false);
    });

    test("a round count is always at least one round", () => {
        expect(InvestigatedClaimRowSchema.safeParse({ ...row, rounds_run: 0 }).success).toBe(false);
    });

    test("an available section reports both bounds, and may hold only a completeness list", () => {
        const emptied = {
            coverage: "available",
            data: {
                rows: [],
                not_investigated: [{ organ: "ocular", reason: "not_corroborated", detail: "fewer independent sources than the fold requires" }],
                round_bound: 2,
                claim_budget: 6,
            },
        };
        expect(ClaimInvestigationSchema.safeParse(emptied).success).toBe(true);
        expect(ClaimInvestigationSchema.safeParse({ ...emptied, data: { ...emptied.data, round_bound: 0 } }).success).toBe(false);
    });

    test("an uninvestigated entry names a canonical organ and a stated reason", () => {
        const section = {
            coverage: "available",
            data: { rows: [], not_investigated: [{ organ: "liver", reason: "not_corroborated", detail: "d" }], round_bound: 2, claim_budget: 6 },
        };
        expect(ClaimInvestigationSchema.safeParse(section).success).toBe(false);
    });
});

describe("organ vocabulary", () => {
    const flag = {
        organ: "hepatic",
        trail: "trail",
        severity: "high",
        support: { state: "unknown", reason: "no citable record" },
    };

    test("a canonical organ parses", () => {
        expect(SafetyFlagSchema.safeParse(flag).success).toBe(true);
    });

    test("a non-canonical organ does not", () => {
        for (const organ of ["hepatobiliary", "liver", "central nervous system", "HEPATIC"]) {
            expect({ organ, ok: SafetyFlagSchema.safeParse({ ...flag, organ }).success }).toEqual({ organ, ok: false });
        }
    });

    test("every canonical token is accepted by a dossier organ field", () => {
        for (const organ of ORGAN_SYSTEMS) {
            expect({ organ, ok: SafetyFlagSchema.safeParse({ ...flag, organ }).success }).toEqual({ organ, ok: true });
        }
    });
});
