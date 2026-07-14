import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DossierV4Body } from "../../../contracts/target-dossier.js";
import {
    __resetApprovalPrecedentCacheForTest,
    fetchApprovalPrecedents,
    pickIndicationForPrecedents,
    renderApprovalPrecedents,
    type Precedent,
} from "./approval-precedents.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: () => Response): void {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

/** Build a minimal dossier touching only the fields the picker reads. */
function makeDossier(opts: {
    indications: { coverage: "available"; rows: Array<{ disease_name: string; composite_score: number }> } | { coverage: "queried_no_data" | "not_loaded" };
    inferredTherapeuticArea: string | null;
}): DossierV4Body {
    const indications =
        opts.indications.coverage === "available"
            ? { coverage: "available" as const, data: { rows: opts.indications.rows } }
            : { coverage: opts.indications.coverage };
    return {
        indications,
        liability_summary: { inferred_therapeutic_area: opts.inferredTherapeuticArea },
    } as unknown as DossierV4Body;
}

describe("pickIndicationForPrecedents", () => {
    it("returns the top indication row by composite_score", () => {
        const dossier = makeDossier({
            indications: {
                coverage: "available",
                rows: [
                    { disease_name: "melanoma", composite_score: 0.4 },
                    { disease_name: "non-small cell lung carcinoma", composite_score: 0.9 },
                    { disease_name: "colorectal carcinoma", composite_score: 0.7 },
                ],
            },
            inferredTherapeuticArea: "oncology",
        });
        expect(pickIndicationForPrecedents(dossier)).toBe("non-small cell lung carcinoma");
    });

    it("falls back to inferred_therapeutic_area when indications coverage is unavailable", () => {
        const dossier = makeDossier({
            indications: { coverage: "queried_no_data" },
            inferredTherapeuticArea: "type 2 diabetes mellitus",
        });
        expect(pickIndicationForPrecedents(dossier)).toBe("type 2 diabetes mellitus");
    });

    it("falls back to inferred_therapeutic_area when indications is available but has no rows", () => {
        const dossier = makeDossier({
            indications: { coverage: "available", rows: [] },
            inferredTherapeuticArea: "immunology",
        });
        expect(pickIndicationForPrecedents(dossier)).toBe("immunology");
    });

    it("returns null when neither indications rows nor an inferred area are present", () => {
        const dossier = makeDossier({
            indications: { coverage: "not_loaded" },
            inferredTherapeuticArea: null,
        });
        expect(pickIndicationForPrecedents(dossier)).toBeNull();
    });
});

describe("renderApprovalPrecedents", () => {
    it("notes that no precedents were queried when the indication is null", () => {
        const block = renderApprovalPrecedents(null, null);
        expect(block).toContain("## FDA approval precedents");
        expect(block.toLowerCase()).toContain("no indication could be resolved");
    });

    it("states no precedents were found and warns against asserting class precedents when empty", () => {
        const block = renderApprovalPrecedents("melanoma", { precedents: [] });
        expect(block).toContain("## FDA approval precedents");
        expect(block).toContain('No FDA approval precedents were found for "melanoma"');
        expect(block.toLowerCase()).toContain("do not assert class precedents");
    });

    it("renders a bullet per precedent with nested label-section excerpts", () => {
        const precedents: Precedent[] = [
            {
                application_number: "BLA125514",
                brand_name: "Keytruda",
                generic_name: "pembrolizumab",
                approval_date: "20140904",
                label_section_excerpts: {
                    boxed_warning: "Immune-mediated adverse reactions may occur.",
                    contraindications: "None.",
                },
            },
        ];
        const block = renderApprovalPrecedents("melanoma", { precedents });
        expect(block).toContain("## FDA approval precedents");
        expect(block).toContain("- pembrolizumab (Keytruda), BLA125514, approved 20140904");
        expect(block).toContain("  - boxed_warning: Immune-mediated adverse reactions may occur.");
        expect(block).toContain("  - contraindications: None.");
    });
});

describe("fetchApprovalPrecedents", () => {
    beforeEach(() => {
        __resetApprovalPrecedentCacheForTest();
    });

    it("maps openFDA label results into precedents", async () => {
        stubFetch(() =>
            json({
                results: [
                    {
                        openfda: {
                            application_number: ["BLA125514"],
                            brand_name: ["Keytruda"],
                            generic_name: ["pembrolizumab"],
                        },
                        effective_time: "20140904",
                        boxed_warning: ["Immune-mediated adverse reactions may occur."],
                        contraindications: ["None."],
                    },
                ],
            }),
        );

        const { precedents } = await fetchApprovalPrecedents({ indication: "melanoma" });
        expect(precedents).toHaveLength(1);
        expect(precedents[0]!.application_number).toBe("BLA125514");
        expect(precedents[0]!.generic_name).toBe("pembrolizumab");
        expect(precedents[0]!.approval_date).toBe("20140904");
        expect(precedents[0]!.label_section_excerpts).toEqual({
            boxed_warning: "Immune-mediated adverse reactions may occur.",
            contraindications: "None.",
        });
    });

    it("treats a 404 as an empty precedent set", async () => {
        __resetApprovalPrecedentCacheForTest();
        stubFetch(() => new Response("not found", { status: 404 }));
        const { precedents } = await fetchApprovalPrecedents({ indication: "no-such-disease" });
        expect(precedents).toEqual([]);
    });

    it("throws on a non-404 upstream failure", async () => {
        __resetApprovalPrecedentCacheForTest();
        stubFetch(() => new Response("upstream down", { status: 500 }));
        await expect(fetchApprovalPrecedents({ indication: "melanoma" })).rejects.toThrow();
    });
});
