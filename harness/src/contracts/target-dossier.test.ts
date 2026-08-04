import { describe, expect, test } from "bun:test";

import { ORGAN_SYSTEMS } from "./organ-system.js";
import {
    ClaimEvidenceSchema,
    ClaimSupportSchema,
    CoverageSchema,
    DossierSchema,
    RowCoverageSchema,
    SafetyFlagSchema,
    SafetyProfileSchema,
} from "./target-dossier.js";

/**
 * Sections whose content does not depend on an enrichment source, and so
 * carry no coverage envelope. Listing them explicitly is what makes the
 * conformance test below fail when a new top-level section is added without
 * a deliberate decision about which group it belongs to.
 */
const NON_ENRICHMENT_SECTIONS = ["entity", "generated_at", "liability_summary", "derived"] as const;

/** Sections that group other sections rather than holding data of their own. */
const CONTAINER_SECTIONS = ["clinical_development", "safety_profile", "reference_biology", "analytics"] as const;

describe("coverage discipline", () => {
    test("carries exactly the four states, with the original three unchanged", () => {
        expect(new Set(CoverageSchema.options)).toEqual(new Set(["available", "queried_no_data", "not_loaded", "filtered"]));
    });

    test("a row marker cannot be filtered", () => {
        expect(RowCoverageSchema.safeParse("filtered").success).toBe(false);
        expect(RowCoverageSchema.safeParse("queried_no_data").success).toBe(true);
    });

    test("every top-level dossier section is classified, and enrichment-dependent ones are enveloped", () => {
        for (const [key, section] of Object.entries(DossierSchema.shape)) {
            if ((NON_ENRICHMENT_SECTIONS as readonly string[]).includes(key)) continue;
            if ((CONTAINER_SECTIONS as readonly string[]).includes(key)) continue;
            expect({ key, enveloped: section.safeParse({ coverage: "not_loaded" }).success }).toEqual({ key, enveloped: true });
        }
    });

    test("every safety-profile section is enveloped", () => {
        for (const [key, section] of Object.entries(SafetyProfileSchema.shape)) {
            expect({ key, enveloped: section.safeParse({ coverage: "not_loaded" }).success }).toEqual({ key, enveloped: true });
        }
    });

    test("filtered reports what ran and what it discarded", () => {
        const section = SafetyProfileSchema.shape.organ_rollup;
        expect(section.safeParse({ coverage: "filtered", filter: "below pchembl floor", dropped_count: 4 }).success).toBe(true);
        expect(section.safeParse({ coverage: "filtered" }).success).toBe(false);
    });

    test("a partially filtered section reports its own drops", () => {
        const section = SafetyProfileSchema.shape.organ_rollup;
        expect(section.safeParse({ coverage: "available", data: { rows: [] }, dropped_count: 3 }).success).toBe(true);
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
