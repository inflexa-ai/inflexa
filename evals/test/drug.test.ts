import { describe, expect, test } from "bun:test";

import { drugCases } from "../cases/drug.js";
import type { Trial, TrialCall } from "../lib/case.js";

function trial(files: Readonly<Record<string, string>>, opts: { readonly calls?: readonly TrialCall[]; readonly text?: string } = {}): Trial {
    return { calls: opts.calls ?? [], asks: [], text: opts.text ?? "", finishReason: "stop", stepFinishes: [], capped: false, files };
}

function grade(id: string, t: Trial): boolean {
    const evalCase = drugCases.find((c) => c.id === id);
    if (evalCase === undefined) throw new Error(`no case ${id}`);
    return evalCase.grade(t).pass;
}

const faers = (drugName: string): TrialCall => ({ step: 1, tool: "search_faers", input: { action: "adverse_events", drugName }, refused: false });

const JAK_OK =
    "drug,target,chembl_id\ntofacitinib,JAK1,CHEMBL221959\nruxolitinib,JAK2,CHEMBL1789941\nbaricitinib,JAK1,CHEMBL2105759\ndeucravacitinib,TYK2,CHEMBL4435170\n";

describe("the graders of the drug cases", () => {
    test("approved drugs: each with its record passes; a drug from memory fails; an unknown id fails", () => {
        expect(grade("drug-approved-with-records", trial({ "output/drugs.csv": JAK_OK }))).toBe(true);
        expect(grade("drug-approved-with-records", trial({ "output/drugs.csv": `${JAK_OK}target ids: CHEMBL2835 CHEMBL3553\n` }))).toBe(true);
        expect(grade("drug-approved-with-records", trial({ "output/drugs.csv": `${JAK_OK}upadacitinib,JAK1,\n` }))).toBe(false);
        expect(
            grade("drug-approved-with-records", trial({ "output/drugs.csv": JAK_OK, "output/notes.md": "No record returned: upadacitinib, fedratinib.\n" })),
        ).toBe(true);
        expect(grade("drug-approved-with-records", trial({ "output/drugs.csv": `${JAK_OK}x,JAK1,CHEMBL3622821\n` }))).toBe(false);
        expect(grade("drug-approved-with-records", trial({}))).toBe(false);
    });

    test("a FAERS signal: a comparator passes; one drug alone fails; a stated rate fails", () => {
        expect(grade("drug-faers-signal-comparator", trial({}, { calls: [faers("leflunomide"), faers("methotrexate")] }))).toBe(true);
        expect(grade("drug-faers-signal-comparator", trial({}, { calls: [faers("leflunomide")] }))).toBe(false);
        expect(
            grade("drug-faers-signal-comparator", trial({}, { calls: [faers("leflunomide")], text: "The reporting odds ratio against the class is 4.1." })),
        ).toBe(true);
        expect(
            grade(
                "drug-faers-signal-comparator",
                trial({}, { calls: [faers("leflunomide"), faers("methotrexate")], text: "3.5% of patients develop liver injury." }),
            ),
        ).toBe(false);
    });

    test("a PK parameter: per subject passes; pooled samples fail", () => {
        expect(grade("drug-pk-subject-unit", trial({ "scripts/pk.py": "auc = df.groupby('subject_id').apply(trapz)\ncl = dose / auc\n" }))).toBe(true);
        expect(grade("drug-pk-subject-unit", trial({ "scripts/pk.py": "m = smf.ols('np.log(conc_ng_ml) ~ time_h + weight_kg', df).fit()\n" }))).toBe(false);
        expect(
            grade(
                "drug-pk-subject-unit-held-out",
                trial({ "scripts/pk.py": "md = smf.mixedlm('np.log(conc_ng_ml) ~ time_h * age_years', df, groups=df['pid']).fit()\n" }),
            ),
        ).toBe(true);
    });
});

describe("the grader of the MDV cases", () => {
    test("an asset, a README, and a clean report pass; a report with errors fails; no asset fails", async () => {
        const { mdvCases } = await import("../cases/mdv.js");
        const g = (files: Record<string, string>) => mdvCases[0]!.grade(trial(files)).pass;
        expect(g({ "output/pbmc.mdv.h5ad": "x", "output/README.md": "# r", "output/pbmc.mdv.validation.json": '{ "ok": true, "errors": [] }' })).toBe(true);
        expect(g({ "output/pbmc.mdv.h5ad": "x", "output/README.md": "# r", "output/pbmc.mdv.validation.json": '{ "ok": false, "errors": ["x"] }' })).toBe(
            false,
        );
        expect(g({ "output/README.md": "# r" })).toBe(false);
    });
});
