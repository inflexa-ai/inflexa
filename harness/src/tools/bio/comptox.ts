/**
 * comptox — the single EPA CompTox (CTX) tool: ToxCast/Tox21 bioactivity,
 * in-vivo hazard, chemical identity + physchem, and exposure behind one
 * `dataset` discriminator.
 *
 * All four datasets key off the same chemical resolution and the same
 * EPA_CCTE_API_KEY, so the key contract is stated once in the description
 * rather than four times.
 *
 * The input is a flat object with a `dataset` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (the model needs a
 * top-level `"type":"object"`). `dataType` and `limit` mean different things
 * per dataset, so `.refine` guards reject a value that belongs to another
 * dataset (a 'toxval' under dataset 'exposure' would otherwise silently fetch
 * nothing) and a limit above the dataset's own ceiling.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import {
    fetchCtxChemicalDetail,
    fetchCtxChemicalProperties,
    fetchCtxExposureData,
    fetchCtxHazardData,
    fetchToxcastBioactivity,
    resolveDtxsid,
    type ChemicalDetail,
    type CtxExposureData,
    type CtxExposureDataType,
    type CtxHazardData,
    type CtxHazardDataType,
    type PropertySummary,
    type ToxcastBioactivity,
} from "../lib/ctx-ops.js";
import { getEpaCcteHeaders } from "../lib/toxcast-config.js";

const HAZARD_DATA_TYPES = ["toxval", "genetox", "cancer", "all"] as const;
const EXPOSURE_DATA_TYPES = ["seem", "httk", "functional-use", "product-data", "all"] as const;

function isHazardDataType(value: string | undefined): value is CtxHazardDataType {
    return value !== undefined && (HAZARD_DATA_TYPES as readonly string[]).includes(value);
}

function isExposureDataType(value: string | undefined): value is CtxExposureDataType {
    return value !== undefined && (EXPOSURE_DATA_TYPES as readonly string[]).includes(value);
}

const inputSchema = z
    .object({
        dataset: z
            .enum(["toxcast", "hazard", "chemical", "exposure"])
            .describe(
                "Which CompTox dataset to query; each names its return fields.\n" +
                    "'toxcast' — ToxCast/Tox21 in-vitro HTS across hundreds of endpoints (nuclear receptors, stress response, mitochondrial toxicity): 'is " +
                    "this an endocrine disruptor?'. → the resolved chemical plus assay rows (endpoint, AC50, hit call; AC50 ascending), and totalAssays / " +
                    "activeAssays / activeHitRate, which always describe the FULL tested panel, not the returned slice.\n" +
                    "'hazard' — ToxValDB / ToxRefDB IN-VIVO hazard: the points of departure a safety evaluation rests on. → dose-response rows (toxvalType " +
                    "NOAEL/LOAEL/LD50/BMD with value, units, study type and duration, species, route, effect), genotoxicity summaries, cancer classifications.\n" +
                    "'chemical' — identity and physicochemical profile, and the way to get the DTXSID the other datasets key off. → DTXSID, CASRN, SMILES, " +
                    "InChIKey, formula, mass, plus (unless includeProperties is false) experimental and predicted properties — logP, water solubility, vapor " +
                    "pressure, melting/boiling point, bioconcentration factor, Henry's law constant.\n" +
                    "'exposure' — the exposure half of a risk assessment (e.g. an AC50 against predicted exposure for a bioactivity-exposure ratio). → SEEM " +
                    "predictions (production volume and per-pathway probabilities: dietary, residential, pesticide, industrial — NOT a daily-intake dose), " +
                    "HTTK toxicokinetic parameters, reported functional uses, consumer-product composition.",
            ),
        query: z
            .string()
            .describe(
                "Chemical identifier (all datasets). A DTXSID ('DTXSID7020182') is used directly; a CASRN ('80-05-7'), a name ('bisphenol A'), or — for " +
                    "dataset 'chemical' — an InChIKey is resolved by EXACT match, so a non-canonical or misspelled name yields found: false.",
            ),
        dataType: z
            .enum(["toxval", "genetox", "cancer", "seem", "httk", "functional-use", "product-data", "all"])
            .optional()
            .describe(
                "Which sections to fetch — datasets 'hazard' and 'exposure' only, ignored by the single-dataset 'toxcast' and 'chemical'. Default 'all', " +
                    "which fetches every section of that dataset concurrently. " +
                    "'hazard': 'toxval' (dose-response — NOAELs, LOAELs, LD50s, BMDs), 'genetox' (genotoxicity summaries), 'cancer' (IARC/EPA/NTP-style " +
                    "classifications). " +
                    "'exposure': 'seem' (exposure-pathway predictions + production volume), 'httk' (toxicokinetics — clearance, Css, protein binding), " +
                    "'functional-use' (reported use categories), 'product-data' (consumer-product composition).",
            ),
        activeOnly: z
            .boolean()
            .optional()
            .describe(
                "'toxcast' only. Default true — hit (active) assays only. False for the whole tested panel including inactives, needed to judge selectivity " +
                    "or a low hit rate.",
            ),
        includeProperties: z
            .boolean()
            .optional()
            .describe(
                "'chemical' only. Default true — also fetch experimental/predicted properties. False skips that second call when only identity and mass are needed.",
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe(
                "Max rows; ignored by 'chemical'. Per dataset: 'toxcast' default 25 / max 200, applied after activeOnly and AC50-ascending so the default " +
                    "keeps the most potent hits; 'hazard' default 30 / max 100, applied to toxval and genetox only — cancer always returns every row (only " +
                    "ever a handful); 'exposure' default 25 / max 100, applied to functional-use and product-data only — seem is one record and httk a short " +
                    "parameter list, both returned whole.",
            ),
    })
    .refine((d) => (d.dataset !== "toxcast" && d.dataset !== "chemical") || d.dataType === undefined || d.dataType === "all", {
        message:
            "dataType applies only to dataset 'hazard' (toxval | genetox | cancer) and dataset 'exposure' (seem | httk | functional-use | product-data) — " +
            "'toxcast' and 'chemical' each return one dataset. Select the dataset that owns the sections you want.",
        path: ["dataType"],
    })
    .refine((d) => d.dataset !== "hazard" || d.dataType === undefined || isHazardDataType(d.dataType), {
        message:
            "dataType must be 'toxval', 'genetox', 'cancer', or 'all' when dataset is 'hazard' — " +
            "seem / httk / functional-use / product-data belong to dataset 'exposure'.",
        path: ["dataType"],
    })
    .refine((d) => d.dataset !== "exposure" || d.dataType === undefined || isExposureDataType(d.dataType), {
        message:
            "dataType must be 'seem', 'httk', 'functional-use', 'product-data', or 'all' when dataset is 'exposure' — " +
            "toxval / genetox / cancer belong to dataset 'hazard'.",
        path: ["dataType"],
    })
    .refine((d) => d.dataset === "toxcast" || d.limit === undefined || d.limit <= 100, {
        message: "limit is capped at 100 for datasets 'hazard' and 'exposure' (only 'toxcast' accepts up to 200)",
        path: ["limit"],
    });

type ComptoxOutput =
    | { found: false; query: string }
    | { found: true; chemical: { dtxsid: string; preferredName: string; casrn: string | null } & ToxcastBioactivity }
    | ({ found: true; dtxsid: string; preferredName: string } & CtxHazardData)
    | { found: true; detail: ChemicalDetail; properties?: PropertySummary[] }
    | ({ found: true; dtxsid: string } & CtxExposureData);

export function createComptoxTool(deps: { apiKey: string }) {
    return defineTool({
        id: "comptox",
        description:
            "The CompTox Chemicals Dashboard (CTX) of the U.S. Environmental Protection Agency — the chemical-safety corpus that holds ToxCast, ToxValDB, " +
            "the genotoxicity and cancer summaries, and the SEEM exposure predictions. Four datasets behind `dataset`: 'toxcast' (in-vitro HTS " +
            "bioactivity), 'hazard' (in-vivo: " +
            "NOAEL/LOAEL/LD50, genotoxicity, cancer), 'chemical' (identity + physicochemical/ADMET), 'exposure' (SEEM predictions, toxicokinetics, uses, " +
            "products). See `dataset` for what each returns; all four resolve `query` to a DTXSID first.\n" +
            "ACCEPTED IDENTIFIERS: a DTXSID ('DTXSID7020182') used directly, or a CASRN ('80-05-7'), a chemical name ('bisphenol A') or — for dataset " +
            "'chemical' — an InChIKey, each resolved by EXACT match.\n" +
            "Requires EPA_CCTE_API_KEY — a missing key fails terminally: do NOT retry, tell the user the key needs configuring and proceed without EPA data.\n" +
            "found: false means the query did not resolve to a chemical; a present-but-empty section is likewise valid no-data. Do not retry either.\n" +
            "This is environmental/industrial-chemical data: for drug-like compounds prefer PubChem or ChEMBL — dataset 'chemical' returns " +
            "`detail.pubchemCid` to bridge back.",
        inputSchema,
        describeCall: "none",
        execute: async (input): Promise<Result<ComptoxOutput, ToolError>> => {
            const headers = getEpaCcteHeaders(deps.apiKey);
            const resolved = await resolveDtxsid(input.query, headers);
            // "No chemical found" is an expected outcome — a data variant, not an error.
            if (!resolved) return ok({ found: false as const, query: input.query });

            const { dtxsid, preferredName, casrn } = resolved;

            switch (input.dataset) {
                case "toxcast": {
                    const bioactivity = await fetchToxcastBioactivity(dtxsid, headers, {
                        activeOnly: input.activeOnly ?? true,
                        limit: input.limit ?? 25,
                    });
                    return ok({ found: true as const, chemical: { dtxsid, preferredName, casrn, ...bioactivity } });
                }
                case "hazard": {
                    const data = await fetchCtxHazardData(dtxsid, headers, {
                        dataType: isHazardDataType(input.dataType) ? input.dataType : "all",
                        limit: input.limit ?? 30,
                    });
                    return ok({ found: true as const, dtxsid, preferredName, ...data });
                }
                case "chemical": {
                    const detail = await fetchCtxChemicalDetail(dtxsid, headers);
                    const result: { found: true; detail: ChemicalDetail; properties?: PropertySummary[] } = { found: true, detail };

                    if (input.includeProperties ?? true) {
                        const properties = await fetchCtxChemicalProperties(dtxsid, headers);
                        if (properties) result.properties = properties;
                    }

                    return ok(result);
                }
                case "exposure": {
                    const data = await fetchCtxExposureData(dtxsid, headers, {
                        dataType: isExposureDataType(input.dataType) ? input.dataType : "all",
                        limit: input.limit ?? 25,
                    });
                    return ok({ found: true as const, dtxsid, ...data });
                }
            }
        },
    });
}
