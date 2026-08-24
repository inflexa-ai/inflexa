/**
 * The catalogue is data, and the properties that make it usable are properties OF that
 * data: one entry per id, an `other` escape everywhere a category is chosen, and a
 * default treatment on every dimension category. A catalogue missing any of those is one
 * an author fills in by vibe.
 */

import { describe, expect, it } from "bun:test";

import {
    DIMENSION_CATEGORIES,
    DIMENSION_CATEGORY_IDS,
    DIMENSION_PROBES,
    DIMENSION_PROBE_IDS,
    GROUP_CATEGORIES,
    GROUP_CATEGORY_IDS,
    GROUP_ROLES,
    GROUP_ROLE_IDS,
    dimensionCategoryEntry,
    dimensionScope,
    groupCategoryEntry,
} from "./profile-vocabulary.js";

describe("the shipped vocabulary", () => {
    it("carries exactly one entry per id, in the same order", () => {
        expect(GROUP_ROLES.map((entry) => entry.id)).toEqual([...GROUP_ROLE_IDS]);
        expect(GROUP_CATEGORIES.map((entry) => entry.id)).toEqual([...GROUP_CATEGORY_IDS]);
        expect(DIMENSION_CATEGORIES.map((entry) => entry.id)).toEqual([...DIMENSION_CATEGORY_IDS]);
        expect(DIMENSION_PROBES.map((entry) => entry.id)).toEqual([...DIMENSION_PROBE_IDS]);
    });

    it("closes every category enum with an `other` escape", () => {
        expect(GROUP_CATEGORY_IDS).toContain("other");
        expect(DIMENSION_CATEGORY_IDS).toContain("other");
        // Roles are not a taxonomy of content, so they close without one.
        expect(GROUP_ROLE_IDS).not.toContain("other");
    });

    it("gives every category its nearest neighbour and, for a dimension, a default treatment", () => {
        for (const entry of GROUP_CATEGORIES) expect(entry.note.length).toBeGreaterThan(0);
        for (const entry of DIMENSION_CATEGORIES) {
            expect(entry.note.length).toBeGreaterThan(0);
            expect(["split", "dimension"]).toContain(entry.defaultTreatment);
            expect(["biological", "technical"]).toContain(entry.scope);
        }
    });

    it("derives a dimension's scope from its category rather than accepting one", () => {
        expect(dimensionScope("subject")).toBe("biological");
        expect(dimensionScope("batch")).toBe("technical");
    });

    it("defaults the canonical substrate cases to a split and the never-split cases to a dimension", () => {
        expect(dimensionCategoryEntry("variant-origin").defaultTreatment).toBe("split");
        expect(dimensionCategoryEntry("assay-modality").defaultTreatment).toBe("split");
        expect(dimensionCategoryEntry("organism-species").defaultTreatment).toBe("split");
        expect(dimensionCategoryEntry("subject").defaultTreatment).toBe("dimension");
        expect(dimensionCategoryEntry("batch").defaultTreatment).toBe("dimension");
        // Assigned-by-design grouping is consumed together by comparative models.
        expect(dimensionCategoryEntry("cohort-arm").defaultTreatment).toBe("dimension");
    });

    it("resolves an entry for every id", () => {
        for (const id of GROUP_CATEGORY_IDS) expect(groupCategoryEntry(id).id).toBe(id);
        for (const id of DIMENSION_CATEGORY_IDS) expect(dimensionCategoryEntry(id).id).toBe(id);
    });

    it("probes only the dimensions a bounded search can settle", () => {
        expect([...DIMENSION_PROBE_IDS]).toEqual(["subject", "sample", "cohort-arm", "timepoint", "batch"]);
        // Probing these would invite inferring structure that was never written down.
        expect(DIMENSION_PROBE_IDS).not.toContain("assay-modality");
        expect(DIMENSION_PROBE_IDS).not.toContain("replicate");
    });
});
