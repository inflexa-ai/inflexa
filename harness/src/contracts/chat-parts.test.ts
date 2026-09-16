import { describe, expect, test } from "bun:test";

import { CortexChatPartSchema, PresentationContentSchema, PresentationPartSchema } from "./schemas/chat-parts.js";

describe("PresentationContentSchema — echart dataPath", () => {
    test("accepts an echart content carrying dataPath and round-trips it (does not strip it)", () => {
        const content = {
            kind: "echart" as const,
            spec: { series: [{ type: "bar" }] },
            dataPath: "runs/run-abc/step-2/output/de-summary.csv",
        };
        const parsed = PresentationContentSchema.parse(content);
        expect(parsed).toEqual(content);
    });

    test("accepts an echart content without dataPath (optional)", () => {
        const content = { kind: "echart" as const, spec: { series: [] } };
        const parsed = PresentationContentSchema.parse(content);
        expect(parsed).toEqual(content);
        expect("dataPath" in parsed).toBe(false);
    });

    test("a full data-presentation part preserves the echart dataPath through the union schema", () => {
        const part = {
            type: "data-presentation" as const,
            id: "pres-abc123",
            title: "DE genes",
            content: {
                kind: "echart" as const,
                spec: { xAxis: {}, yAxis: {}, series: [] },
                dataPath: "runs/run-abc/step-2/output/de-summary.csv",
            },
        };
        expect(PresentationPartSchema.parse(part)).toEqual(part);
        expect(CortexChatPartSchema.parse(part)).toEqual(part);
    });
});

describe("PresentationContentSchema — structure", () => {
    const structure = {
        kind: "structure" as const,
        format: "mmcif" as const,
        url: "https://alphafold.ebi.ac.uk/files/AF-P38398-F1-model_v6.cif",
        provider: "alphafold" as const,
        accession: "P38398",
        version: 6,
    };

    test("accepts a normalized structure content and round-trips it", () => {
        expect(PresentationContentSchema.parse(structure)).toEqual(structure);
        const part = { type: "data-presentation" as const, id: "pres-abc123", title: "BRCA1", content: structure };
        expect(CortexChatPartSchema.parse(part)).toEqual(part);
    });

    test("rejects a structure content missing a derived field", () => {
        const { accession: _accession, ...noAccession } = structure;
        const { version: _version, ...noVersion } = structure;
        expect(PresentationContentSchema.safeParse(noAccession).success).toBe(false);
        expect(PresentationContentSchema.safeParse(noVersion).success).toBe(false);
        expect(PresentationContentSchema.safeParse({ ...structure, version: 0 }).success).toBe(false);
    });
});
