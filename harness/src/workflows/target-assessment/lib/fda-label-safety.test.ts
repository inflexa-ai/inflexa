import { describe, expect, it } from "bun:test";

import { ClaimSupportSchema, RegulatoryOrganSignalsSchema } from "../../../contracts/target-dossier.js";
import { assembleRegulatoryOrganSignals } from "../assemblers/safety.js";
import { ORGAN_RESOLUTION_FILTER, segmentLabelSafety, splitWarningProse, type FdaLabelSafety } from "./fda-label-safety.js";

function label(sections: FdaLabelSafety["sections"], overrides: Partial<FdaLabelSafety> = {}): FdaLabelSafety {
    return {
        application_number: "NDA021436",
        drug_name: "exenatide",
        effective_time: "20180101",
        sections,
        ...overrides,
    };
}

describe("splitWarningProse", () => {
    it("splits on numbered label-section markers and keeps the marker with its prose", () => {
        const fragments = splitWarningProse(
            "5.1 Pancreatitis: acute pancreatitis has been reported. 5.2 Hepatotoxicity: transaminase elevations have been observed.",
        );
        expect(fragments.map((f) => f.marker)).toEqual(["5.1", "5.2"]);
        expect(fragments[0]!.text).toStartWith("Pancreatitis:");
        expect(fragments[1]!.text).toStartWith("Hepatotoxicity:");
    });

    it("does not read a dose as a label-section marker", () => {
        const fragments = splitWarningProse("Administer 2.5 mg daily; nausea and vomiting have been reported frequently.");
        expect(fragments).toHaveLength(1);
        expect(fragments[0]!.marker).toBeNull();
    });

    it("splits bullets without severing a wrapped sentence", () => {
        const fragments = splitWarningProse("• Acute pancreatitis, including fatal\ncases, has been reported.\n• Hepatic failure has been reported.");
        expect(fragments).toHaveLength(2);
        expect(fragments[0]!.text).toContain("including fatal cases");
    });
});

describe("segmentLabelSafety", () => {
    it("attributes each fragment to a canonical organ", () => {
        const { signals } = segmentLabelSafety([
            label([
                {
                    section: "warnings_and_precautions",
                    text: "5.1 Pancreatitis: acute pancreatitis has been reported. 5.2 Hepatotoxicity: transaminase elevations have been observed.",
                },
            ]),
        ]);
        expect(signals.map((s) => ({ organ: s.organ, section: s.label_section }))).toEqual([
            { organ: "pancreas", section: "5.1" },
            { organ: "hepatic", section: "5.2" },
        ]);
    });

    it("drops a fragment whose organ does not resolve and counts it", () => {
        const projection = segmentLabelSafety([
            label([
                {
                    section: "warnings_and_precautions",
                    text: "5.1 Hepatotoxicity: transaminase elevations have been observed. 5.2 Immunogenicity: antibody formation was measured in all subjects.",
                },
            ]),
        ]);
        expect(projection.signals).toHaveLength(1);
        expect(projection.signals[0]!.organ).toBe("hepatic");
        expect(projection.dropped_count).toBe(1);
    });

    it("files an unresolved fragment nowhere rather than under a neighbouring organ", () => {
        const projection = segmentLabelSafety([
            label([
                {
                    section: "warnings_and_precautions",
                    text: "5.1 Hepatotoxicity: transaminase elevations have been observed.\n\nPatients should be counselled on adherence to the dosing schedule.",
                },
            ]),
        ]);
        expect(projection.signals.map((s) => s.excerpt)).toEqual(["Hepatotoxicity: transaminase elevations have been observed."]);
        expect(projection.dropped_count).toBe(1);
    });

    it("emits a signal once when the highlights section repeats the full section", () => {
        const projection = segmentLabelSafety([
            label([
                { section: "warnings_and_precautions", text: "5.1 Pancreatitis: see full prescribing information." },
                {
                    section: "warnings_and_precautions",
                    text: "5.1 Pancreatitis: acute pancreatitis, including fatal and non-fatal haemorrhagic pancreatitis, has been reported.",
                },
            ]),
        ]);
        expect(projection.signals).toHaveLength(1);
        expect(projection.signals[0]!.excerpt).toContain("haemorrhagic pancreatitis");
        expect(projection.dropped_count).toBe(0);
    });

    it("emits verbatim repeated prose once even without a numbered marker", () => {
        const repeated = "Acute pancreatitis, including fatal cases, has been reported in patients treated with this product.";
        const projection = segmentLabelSafety([
            label([
                { section: "boxed_warning", text: repeated },
                { section: "boxed_warning", text: repeated },
            ]),
        ]);
        expect(projection.signals).toHaveLength(1);
    });

    it("carries a locator that resolves the signal back to a label section", () => {
        const { signals } = segmentLabelSafety([
            label([{ section: "boxed_warning", text: "Hepatotoxicity: fatal hepatic failure has been reported." }], {
                source_url: "https://api.fda.gov/drug/label.json?search=NDA021436",
            }),
        ]);
        const evidence = signals[0]!.evidence;
        expect(evidence.regulatory_reference).toEqual({
            document: "FDA prescribing information — exenatide",
            section: "boxed_warning",
            doc_id: "NDA021436",
            doc_url: "https://api.fda.gov/drug/label.json?search=NDA021436",
        });
        expect(ClaimSupportSchema.safeParse({ state: "scored", evidence: [evidence] }).success).toBe(true);
    });

    it("keeps the boxed warning's origin section distinguishable from Section 5", () => {
        const { signals } = segmentLabelSafety([
            label([
                { section: "boxed_warning", text: "Hepatotoxicity: fatal hepatic failure has been reported." },
                { section: "warnings_and_precautions", text: "5.2 Nausea: nausea and vomiting occur frequently." },
            ]),
        ]);
        expect(signals.map((s) => [s.source_section, s.label_section])).toEqual([
            ["boxed_warning", "boxed_warning"],
            ["warnings_and_precautions", "5.2"],
        ]);
    });
});

describe("assembleRegulatoryOrganSignals", () => {
    it("reports filtered with the real dropped count when organ resolution empties the section", () => {
        const section = assembleRegulatoryOrganSignals({ signals: [], dropped_count: 3 });
        expect(section).toEqual({ coverage: "filtered", filter: ORGAN_RESOLUTION_FILTER, dropped_count: 3 });
        expect(RegulatoryOrganSignalsSchema.safeParse(section).success).toBe(true);
    });

    it("reports queried_no_data when the labels carried no warning prose at all", () => {
        const section = assembleRegulatoryOrganSignals({ signals: [], dropped_count: 0 });
        expect(section.coverage).toBe("queried_no_data");
    });

    it("reports not_loaded when no label was queried", () => {
        expect(assembleRegulatoryOrganSignals(null).coverage).toBe("not_loaded");
    });

    it("carries the partial drop count on an available section", () => {
        const projection = segmentLabelSafety([
            label([
                {
                    section: "warnings_and_precautions",
                    text: "5.1 Hepatotoxicity: transaminase elevations have been observed. 5.2 Immunogenicity: antibody formation was measured in all subjects.",
                },
            ]),
        ]);
        const section = assembleRegulatoryOrganSignals(projection);
        expect(RegulatoryOrganSignalsSchema.safeParse(section).success).toBe(true);
        expect(section).toMatchObject({ coverage: "available", dropped_count: 1 });
        if (section.coverage !== "available") throw new Error("expected an available section");
        expect(section.data.rows[0]!.support.state).toBe("scored");
    });
});
