/**
 * The cases of the drug analyst: steps about compounds, exposure, and safety. Each case names the production agent of
 * its domain, and `--sandbox-arm` runs it on a variant. Run them with `--exec docker`: the PK case computes on data.
 */

import type { DataProfileResult } from "@inflexa-ai/harness/contracts/data-profile.js";

import type { ToolScript } from "../lib/agent.js";
import { all, anyOf, neverSays, says, type EvalCase, type Grade, type Trial } from "../lib/case.js";
import type { LockedPackage } from "../lib/sandbox.js";
import { PYTHON_BASE, sandboxCase, type StepSpec } from "./sandbox.js";

const HUMAN = { scientificName: "Homo sapiens", taxonId: "9606" };
const MAX_STEPS = 40;
const TIMEOUT = 3_600_000;

const PY = (names: readonly string[]): LockedPackage[] => names.map((name) => ({ name, version: "1.0.0", track: "python" }));
const LOCK: readonly LockedPackage[] = [...PYTHON_BASE, ...PY(["statsmodels", "scikit-learn"])];

function inputOf(input: unknown): Record<string, unknown> {
    return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function profile(summary: string, files: NonNullable<DataProfileResult["files"]>): DataProfileResult {
    return { summary, files, profiledAt: "2026-11-09T08:00:00.000Z", domain: "pharmacology", organism: { ...HUMAN, source: "metadata", confidence: "high" } };
}

function step(spec: Omit<StepSpec, "stepId" | "profile"> & { readonly profile?: DataProfileResult | null }): StepSpec {
    return { stepId: "T1S1", profile: null, ...spec };
}

// ── Approved drugs of a target list: each drug has its record ────────────────

type Drug = { readonly id: string; readonly name: string; readonly target: string; readonly year: number; readonly indication: string };

/** A scripted ChEMBL over the drugs and the target ids of a case. A drug outside `drugs` has no record. */
function chemblOf(targets: Readonly<Record<string, string>>, drugs: readonly Drug[]): ToolScript {
    return (raw) => {
        const input = inputOf(raw);
        const query = String(input["query"] ?? "").toUpperCase();
        const id = String(input["chemblId"] ?? "");
        switch (input["action"]) {
            case "targets": {
                const target = Object.entries(targets).find(([gene]) => query.includes(gene));
                return {
                    ok: {
                        targets:
                            target === undefined
                                ? []
                                : [
                                      {
                                          targetChemblId: target[1],
                                          preferredName: target[0],
                                          targetType: "SINGLE PROTEIN",
                                          organism: "Homo sapiens",
                                          geneNames: [target[0]],
                                      },
                                  ],
                    },
                };
            }
            case "compounds": {
                const gene = Object.entries(targets).find(([g, t]) => query.includes(g) || query.includes(t))?.[0];
                const hits = drugs.filter((drug) => gene !== undefined && drug.target.split("/").includes(gene));
                return {
                    ok: {
                        compounds: hits.map((drug) => ({
                            chemblId: drug.id,
                            preferredCompoundName: drug.name.toUpperCase(),
                            canonicalSmiles: null,
                            molecularWeight: null,
                            alogp: null,
                            molecularFormula: null,
                        })),
                    },
                };
            }
            case "drug": {
                const hits = drugs.filter((drug) => query.includes(drug.name.toUpperCase()));
                return {
                    ok: {
                        drugs: hits.map((drug) => ({
                            moleculeChemblId: drug.id,
                            preferredName: drug.name.toUpperCase(),
                            maxPhase: 4,
                            moleculeType: "Small molecule",
                            firstApproval: drug.year,
                            indication: drug.indication,
                        })),
                    },
                };
            }
            case "mechanism": {
                const drug = drugs.find((d) => d.id === id);
                return {
                    ok: {
                        mechanisms:
                            drug === undefined
                                ? []
                                : drug.target.split("/").map((gene) => ({
                                      mechanismOfAction: `${gene} inhibitor`,
                                      actionType: "INHIBITOR",
                                      targetChemblId: targets[gene] ?? null,
                                      targetName: gene,
                                      moleculeChemblId: drug.id,
                                  })),
                    },
                };
            }
            default:
                return { ok: { activities: [] } };
        }
    };
}

const NO_RECORDS: ToolScript = { ok: { results: [], note: "No record matches the query." } };

/**
 * The deliverable names approved drugs of the lookups only, with the ChEMBL id of each, and no drug that the lookups did
 * not return. `memory` are approved drugs of the same targets that the scripted ChEMBL does not hold.
 */
function drugsWithRecords(targets: Readonly<Record<string, string>>, drugs: readonly Drug[], memory: readonly string[]): EvalCase["grade"] {
    return (trial: Trial): Grade => {
        const outputs = Object.entries(trial.files ?? {}).filter(([path]) => path.startsWith("output/") && /\.(csv|tsv|md|json)$/.test(path));
        if (outputs.length === 0) return { pass: false, detail: "no deliverable in output/" };
        const text = outputs.map(([, body]) => body).join("\n");
        const ids = new Set(text.match(/CHEMBL\d+/g) ?? []);
        const known = new Set([...drugs.map((drug) => drug.id), ...Object.values(targets)]);
        const invented = [...ids].filter((id) => !known.has(id));
        if (invented.length > 0) return { pass: false, detail: `ids that no lookup returned: ${invented.join(", ")}` };
        const listed = drugs.filter((drug) => ids.has(drug.id));
        if (listed.length < drugs.length - 1) return { pass: false, detail: `only ${listed.length} of ${drugs.length} drugs with their ChEMBL id` };
        // A note may name a drug that the lookups did not return. A table row claims the drug.
        const tables = outputs
            .filter(([path]) => /\.(csv|tsv)$/.test(path))
            .map(([, body]) => body)
            .join("\n");
        const unsourced = memory.filter((name) => new RegExp(`\\b${name}\\b`, "i").test(tables));
        return unsourced.length === 0
            ? { pass: true, detail: `${listed.length} drugs, each with its record` }
            : { pass: false, detail: `drugs with no record: ${unsourced.join(", ")}` };
    };
}

const JAK_TARGETS = { JAK1: "CHEMBL2835", JAK2: "CHEMBL2971", TYK2: "CHEMBL3553" };
const JAK_DRUGS: readonly Drug[] = [
    { id: "CHEMBL221959", name: "tofacitinib", target: "JAK1/JAK2", year: 2012, indication: "rheumatoid arthritis" },
    { id: "CHEMBL1789941", name: "ruxolitinib", target: "JAK1/JAK2", year: 2011, indication: "myelofibrosis" },
    { id: "CHEMBL2105759", name: "baricitinib", target: "JAK1/JAK2", year: 2018, indication: "rheumatoid arthritis" },
    { id: "CHEMBL4435170", name: "deucravacitinib", target: "TYK2", year: 2022, indication: "plaque psoriasis" },
];
const JAK_MEMORY = ["upadacitinib", "fedratinib", "abrocitinib", "momelotinib", "pacritinib", "ritlecitinib", "filgotinib"];

const PDE_TARGETS = { PDE4B: "CHEMBL275", PDE4D: "CHEMBL288", PDE5A: "CHEMBL1827" };
const PDE_DRUGS: readonly Drug[] = [
    { id: "CHEMBL193240", name: "roflumilast", target: "PDE4B/PDE4D", year: 2010, indication: "chronic obstructive pulmonary disease" },
    { id: "CHEMBL514800", name: "apremilast", target: "PDE4B/PDE4D", year: 2014, indication: "psoriatic arthritis" },
    { id: "CHEMBL3184512", name: "crisaborole", target: "PDE4B/PDE4D", year: 2016, indication: "atopic dermatitis" },
    { id: "CHEMBL192", name: "sildenafil", target: "PDE5A", year: 1998, indication: "erectile dysfunction" },
];
const PDE_MEMORY = ["tadalafil", "vardenafil", "avanafil", "ibudilast", "dipyridamole", "orismilast"];

// ── A safety signal from spontaneous reports needs a comparator ─────────────

/** Scripted FAERS: each drug has a fixed number of reports, and `focus` has an excess of the reactions of the question. */
function faersOf(focus: string, reactions: readonly string[]): ToolScript {
    return (raw) => {
        const input = inputOf(raw);
        const name = String(input["drugName"] ?? "").toLowerCase();
        const seed = [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
        const total = 8_000 + (seed % 23) * 900;
        if (input["action"] === "label") return { ok: { labels: [] } };
        if (input["action"] === "seriousness")
            return { ok: { seriousness: { totalReports: total, fatalCount: Math.round(total * 0.02), hospitalizationCount: Math.round(total * 0.2) } } };
        const share = name === focus ? 0.035 : 0.006;
        const events = [
            ...reactions.map((reaction, i) => ({ reaction, count: Math.round(total * share * (1 - i * 0.2)) })),
            { reaction: "Nausea", count: Math.round(total * 0.05) },
            { reaction: "Headache", count: Math.round(total * 0.04) },
            { reaction: "Drug ineffective", count: Math.round(total * 0.06) },
        ].sort((a, b) => b.count - a.count);
        return { ok: { totalReports: total, adverseEvents: events } };
    };
}

/** The step compares the drug with others in the reports, and it states no rate. */
function signalWithComparator(focus: string): EvalCase["grade"] {
    const queried = (trial: Trial): Grade => {
        const names = new Set(
            trial.calls
                .filter((call) => call.tool === "search_faers")
                .map((call) => String(inputOf(call.input)["drugName"] ?? "").toLowerCase())
                .filter((name) => name.length > 0),
        );
        const others = [...names].filter((name) => name !== focus);
        return others.length > 0
            ? { pass: true, detail: `compared with ${others.join(", ")}` }
            : { pass: false, detail: `no comparator (queried: ${[...names].join(", ") || "none"})` };
    };
    return all(
        anyOf(queried, says(/disproportional|reporting odds|\bPRR\b|\bROR\b|comparator|background rate|other drugs of the class/i)),
        neverSays(/incidence (rate )?(is|was|of) \d|\d+(\.\d+)? ?% of (patients|users|people) (develop|had|have|experience)/i),
    );
}

// ── The subject is the unit of a PK parameter ───────────────────────────────

const TIMES = [0.5, 1, 2, 4, 6, 8, 12, 24];

/** Concentrations of a one-compartment model. The clearance rises with the weight, and the half-life rises with the age. */
function pkTable(idColumn: string, covariate: "weight_kg" | "age_years"): string {
    const rows: string[] = [`${idColumn},dose_mg,${covariate},time_h,conc_ng_ml`];
    for (let s = 0; s < 24; s++) {
        const weight = 50 + ((s * 37) % 50);
        const age = 25 + ((s * 29) % 50);
        const dose = [100, 200, 400][s % 3] ?? 100;
        const cl = covariate === "weight_kg" ? 5 * (weight / 70) ** 0.75 : 5;
        const v = covariate === "weight_kg" ? 50 * (weight / 70) : 50 * (1 + (age - 25) / 50);
        const k = cl / v;
        for (const t of TIMES) {
            const noise = 1 + 0.08 * Math.sin(s * 7 + t * 3);
            const conc = ((dose * 1000) / v) * Math.exp(-k * t) * noise;
            rows.push([`S${String(s + 1).padStart(2, "0")}`, dose, covariate === "weight_kg" ? weight : age, t, conc.toFixed(2)].join(","));
        }
    }
    return `${rows.join("\n")}\n`;
}

/** The PK parameter comes from each subject, or a model that groups the samples of a subject. */
function subjectIsUnit(idColumn: string): EvalCase["grade"] {
    const grouped = new RegExp(
        `groupby\\(\\s*\\[?["']${idColumn}["']|groups\\s*=\\s*\\w*\\[?["']?${idColumn}|\\(1\\s*\\|\\s*${idColumn}\\)|random\\s*=\\s*~[^\\n]*${idColumn}|nlme|nlmixr|saemix|for\\s+\\w+\\s*,?\\s*\\w*\\s+in\\s+[^\\n]*${idColumn}|split\\([^)]*${idColumn}|by\\s*=\\s*["']?${idColumn}`,
    );
    return (trial) => {
        const scripts = Object.entries(trial.files ?? {}).filter(([path]) => path.startsWith("scripts/"));
        const pk = scripts.find(([, text]) => /conc|auc|clearance|half/i.test(text));
        if (pk === undefined) return { pass: false, detail: `no PK script (scripts: ${scripts.map(([p]) => p).join(", ") || "none"})` };
        return grouped.test(pk[1])
            ? { pass: true, detail: `${pk[0]} estimates a parameter for each ${idColumn}` }
            : { pass: false, detail: `${pk[0]} pools the samples of the subjects` };
    };
}

// ── The cases ───────────────────────────────────────────────────────────────

export const drugCases: readonly EvalCase[] = [
    sandboxCase({
        id: "drug-approved-with-records",
        set: "dev",
        source: "drug analyst: each claim has its source; a lookup answers what is approved, not memory",
        step: step({
            agent: "drug-analyst",
            name: "Approved drugs of the signature kinases",
            question: "Which approved drugs act on JAK1, JAK2, or TYK2? List each drug with its target and the database record that supports it.",
            acceptance: ["A table of the approved drugs with target, mechanism, and the identifier of the supporting record"],
            goal: "Find existing drugs that act on the kinases of the inflammatory signature.",
        }),
        setup: { files: {}, packages: LOCK },
        tools: { chembl: chemblOf(JAK_TARGETS, JAK_DRUGS), drug_gene_interactions: NO_RECORDS, opentargets: NO_RECORDS },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: drugsWithRecords(JAK_TARGETS, JAK_DRUGS, JAK_MEMORY),
    }),
    sandboxCase({
        id: "drug-approved-with-records-held-out",
        set: "held-out",
        source: "paraphrase of drug-approved-with-records: phosphodiesterase targets",
        step: step({
            agent: "drug-analyst",
            name: "Marketed phosphodiesterase inhibitors",
            question: "Find the marketed inhibitors of PDE4B, PDE4D, and PDE5A, with the evidence record for each.",
            acceptance: ["Each marketed inhibitor with its target and the identifier of its record"],
            goal: "Find existing drugs for the phosphodiesterases of the airway signature.",
        }),
        setup: { files: {}, packages: LOCK },
        tools: { chembl: chemblOf(PDE_TARGETS, PDE_DRUGS), drug_gene_interactions: NO_RECORDS, opentargets: NO_RECORDS },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: drugsWithRecords(PDE_TARGETS, PDE_DRUGS, PDE_MEMORY),
    }),
    sandboxCase({
        id: "drug-faers-signal-comparator",
        set: "dev",
        source: "drug analyst: report counts are not rates; a signal needs a comparator (search_faers description)",
        step: step({
            agent: "drug-analyst",
            name: "Liver safety signal",
            question: "Is liver injury a safety signal for leflunomide in the post-marketing reports?",
            acceptance: ["A statement of whether the reports show a signal, with the numbers that support it"],
            goal: "Assess the liver safety of leflunomide.",
        }),
        setup: { files: {}, packages: LOCK },
        tools: { search_faers: faersOf("leflunomide", ["Drug-induced liver injury", "Hepatic enzyme increased", "Hepatotoxicity"]), target_safety: NO_RECORDS },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: signalWithComparator("leflunomide"),
    }),
    sandboxCase({
        id: "drug-faers-signal-comparator-held-out",
        set: "held-out",
        source: "paraphrase of drug-faers-signal-comparator: clozapine and myocarditis",
        step: step({
            agent: "drug-analyst",
            name: "Cardiac reports",
            question: "Do the spontaneous adverse-event reports point to myocarditis as a problem of clozapine?",
            acceptance: ["A judgement on the myocarditis reports of clozapine, with its numbers"],
            goal: "Assess the cardiac safety of clozapine.",
        }),
        setup: { files: {}, packages: LOCK },
        tools: { search_faers: faersOf("clozapine", ["Myocarditis", "Cardiomyopathy", "Troponin increased"]), target_safety: NO_RECORDS },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: signalWithComparator("clozapine"),
    }),
    sandboxCase({
        id: "drug-pk-subject-unit",
        set: "dev",
        source: "drug analyst: exposure, dose, and time are the design; a PK parameter belongs to a subject",
        step: step({
            agent: "drug-analyst",
            name: "Weight and clearance",
            question: "Does the clearance of the drug change with body weight?",
            acceptance: ["The estimate of the weight effect on clearance, with its interval"],
            goal: "Find the covariates of the drug exposure.",
            profile: profile("Concentration-time data of a phase 1 study: 24 subjects, single oral doses of 100, 200, or 400 mg, 8 samples each.", [
                {
                    path: "data/inputs/f-pk/concentrations.csv",
                    description: "subject_id, dose_mg, weight_kg, time_h, conc_ng_ml",
                    dataType: "pk-concentrations",
                    format: "CSV",
                    rows: 192,
                    cols: 5,
                },
            ]),
        }),
        setup: { files: { "data/inputs/f-pk/concentrations.csv": pkTable("subject_id", "weight_kg") }, packages: LOCK },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: subjectIsUnit("subject_id"),
    }),
    sandboxCase({
        id: "drug-pk-subject-unit-held-out",
        set: "held-out",
        source: "paraphrase of drug-pk-subject-unit: age and half-life",
        step: step({
            agent: "drug-analyst",
            name: "Age and elimination",
            question: "Is the elimination half-life longer in older participants?",
            acceptance: ["The age effect on the half-life, with its interval"],
            goal: "Find what changes the elimination of the drug.",
            profile: profile("Concentration-time data: 24 participants, single oral doses of 100, 200, or 400 mg, 8 samples each.", [
                {
                    path: "data/inputs/f-pk/pk.csv",
                    description: "pid, dose_mg, age_years, time_h, conc_ng_ml",
                    dataType: "pk-concentrations",
                    format: "CSV",
                    rows: 192,
                    cols: 5,
                },
            ]),
        }),
        setup: { files: { "data/inputs/f-pk/pk.csv": pkTable("pid", "age_years") }, packages: LOCK },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: subjectIsUnit("pid"),
    }),
];
