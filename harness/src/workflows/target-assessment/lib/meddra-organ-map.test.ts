import { describe, expect, it } from "bun:test";

import { ORGAN_SYSTEMS, type OrganSystem } from "../../../contracts/organ-system.js";
import { classifyOrgan, classifyTrialAe } from "./meddra-organ-map.js";

/** One MedDRA-style term per canonical token, used to prove each is reachable. */
const TERM_PER_ORGAN: Record<OrganSystem, string> = {
    cardiac: "Cardiac failure congestive",
    vascular: "Deep vein thrombosis",
    hepatic: "Hepatitis fulminant",
    renal: "Renal failure acute",
    cns: "Seizure",
    pns: "Peripheral neuropathy",
    gi: "Nausea",
    pancreas: "Pancreatitis acute",
    endocrine_thyroid: "Thyroid disorder",
    metabolic: "Blood glucose increased",
    hematologic: "Thrombocytopenia",
    immune: "Anaphylactic reaction",
    respiratory: "Pneumonitis",
    reproductive: "Menstrual disorder",
    musculoskeletal: "Arthralgia",
    dermatologic: "Rash maculo-papular",
    ocular: "Retinopathy",
    oncology: "Neoplasm malignant",
};

describe("classifyOrgan", () => {
    it("can produce every token in the canonical vocabulary", () => {
        const produced = new Set<OrganSystem | null>(Object.values(TERM_PER_ORGAN).map((term) => classifyOrgan(term)));
        expect([...produced].sort()).toEqual([...ORGAN_SYSTEMS].sort());
    });

    it("classifies each representative term onto its own token", () => {
        for (const [organ, term] of Object.entries(TERM_PER_ORGAN)) {
            expect(classifyOrgan(term)).toBe(organ as OrganSystem);
        }
    });

    it("resolves a peripheral neuropathy to the peripheral nervous system", () => {
        expect(classifyOrgan("Peripheral neuropathy")).toBe("pns");
        expect(classifyOrgan("Neuropathy peripheral")).toBe("pns");
        expect(classifyOrgan("Polyneuropathy")).toBe("pns");
    });

    it("resolves a central term to the central nervous system", () => {
        expect(classifyOrgan("Hepatic encephalopathy")).toBe("cns");
        expect(classifyOrgan("Cerebral haemorrhage")).toBe("cns");
        expect(classifyOrgan("Seizure")).toBe("cns");
    });

    it("keeps an optic neuropathy ocular rather than peripheral", () => {
        expect(classifyOrgan("Optic neuropathy")).toBe("ocular");
    });

    it("resolves a neoplasm term to oncology", () => {
        expect(classifyOrgan("Neoplasm malignant")).toBe("oncology");
        expect(classifyOrgan("Metastases to lymph nodes")).toBe("oncology");
        expect(classifyOrgan("Acute myeloid leukaemia")).toBe("oncology");
    });

    it("files a malignancy that names its site under that site", () => {
        expect(classifyOrgan("Hepatocellular carcinoma")).toBe("hepatic");
        expect(classifyOrgan("Medullary thyroid carcinoma")).toBe("endocrine_thyroid");
    });

    it("returns null for a term that names no single organ", () => {
        // Paraesthesia names the nervous system without naming a compartment,
        // and adrenal insufficiency is endocrine but not thyroid.
        expect(classifyOrgan("Paraesthesia")).toBeNull();
        expect(classifyOrgan("Adrenal insufficiency")).toBeNull();
        expect(classifyOrgan("Drug ineffective")).toBeNull();
        expect(classifyOrgan("Pyrexia")).toBeNull();
    });

    it("does not let a broad stem steal a term from its own organ", () => {
        expect(classifyOrgan("Respiratory depression")).toBe("respiratory");
        expect(classifyOrgan("Bone marrow depression")).toBe("hematologic");
        expect(classifyOrgan("Thrombocytopenia")).toBe("hematologic");
        expect(classifyOrgan("Rash maculo-papular")).toBe("dermatologic");
        expect(classifyOrgan("Malignant hyperthermia")).toBe("musculoskeletal");
        expect(classifyOrgan("Haematuria")).toBe("renal");
    });
});

describe("classifyTrialAe", () => {
    it("maps a system organ class that names one canonical organ", () => {
        expect(classifyTrialAe({ organ: "Vascular disorders", term: "Hypertension" })).toBe("vascular");
        expect(classifyTrialAe({ organ: "Eye disorders", term: "Vision blurred" })).toBe("ocular");
        expect(classifyTrialAe({ organ: "Neoplasms benign, malignant and unspecified (incl cysts and polyps)", term: "Skin papilloma" })).toBe("oncology");
    });

    it("reads the preferred term when the class spans more than one organ", () => {
        expect(classifyTrialAe({ organ: "Nervous system disorders", term: "Peripheral neuropathy" })).toBe("pns");
        expect(classifyTrialAe({ organ: "Nervous system disorders", term: "Headache" })).toBe("cns");
        expect(classifyTrialAe({ organ: "Endocrine disorders", term: "Hypothyroidism" })).toBe("endocrine_thyroid");
    });

    it("resolves nothing when neither the class nor the term names an organ", () => {
        expect(classifyTrialAe({ organ: "Endocrine disorders", term: "Adrenal insufficiency" })).toBeNull();
        expect(classifyTrialAe({ organ: "General disorders and administration site conditions", term: "Fatigue" })).toBeNull();
    });
});
