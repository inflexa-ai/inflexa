/**
 * genePreclinicalProfile — the in-vivo preclinical picture of one gene: where
 * it is expressed at baseline (Bgee) and what removing it does to a mouse
 * (IMPC), behind one `include`.
 *
 * The two halves share an input exactly — ONE human gene symbol, with the
 * per-species orthologs resolved internally — and answer one question between
 * them: is this target expressed where it needs to act, and is a model organism
 * a fair surrogate for it. They were two tools that were called as a pair.
 *
 * Neither source caps its own output: Bgee returns every annotated tissue per
 * species and IMPC every significant phenotype term, so both halves are trimmed
 * here rather than in the clients — the target-assessment collectors read the
 * same clients and legitimately want full fidelity for the dossier.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { SUPPORTED_SPECIES, getMultiSpeciesExpression, type ExpressionRank, type SupportedSpecies, type TissueRow } from "../lib/bgee-client.js";
import { getKoPhenotypeProfile, type MpTerm, type ViabilityCall, type ViabilityCategory } from "../lib/impc-client.js";

/** Ordered weakest → strongest so `minRank` can be a numeric floor. */
const RANK_ORDER: Record<ExpressionRank, number> = { absent: 0, low: 1, medium: 2, high: 3 };

/** Human + mouse: the pairing that answers "is the mouse a fair surrogate?". */
const DEFAULT_SPECIES: readonly SupportedSpecies[] = ["homo_sapiens", "mus_musculus"];

const DEFAULTS = { tissueLimit: 15, phenotypeLimit: 20, minRank: "low" } as const;

interface BoundedSpeciesEntry {
    species: SupportedSpecies;
    taxonId: number;
    ensemblId: string;
    tissues: TissueRow[];
    /** Tissues Bgee annotated for this species, before `minRank` and `tissueLimit`. */
    tissueCount: number;
    /** Tissues that passed `minRank`, before `tissueLimit`. */
    tissuesAboveMinRank: number;
}

interface ExpressionHalf {
    humanEnsemblId: string | null;
    bySpecies: BoundedSpeciesEntry[];
    notFound: string[];
}

interface KnockoutHalf {
    mouseMarkerSymbol: string | null;
    mgiAccessionId: string | null;
    viability: ViabilityCategory;
    viabilityCalls: ViabilityCall[];
    mpTerms: MpTerm[];
    organSystems: string[];
    sexDimorphic: boolean;
    phenotypeCount: number;
    /** True when `phenotypeLimit` trimmed `mpTerms`; `phenotypeCount` is the real total. */
    phenotypesTrimmed: boolean;
}

const inputSchema = z.object({
    geneSymbol: z
        .string()
        .min(1)
        .describe(
            "HUMAN gene symbol, e.g. 'BRCA1' — one gene per call. Ensembl IDs, mouse symbols and MGI IDs are NOT accepted; the ENSG and the per-species " +
                "orthologs are resolved for you.",
        ),
    include: z
        .array(z.enum(["expression", "knockout"]))
        .min(1)
        .optional()
        .describe(
            "Default BOTH — two sides of one judgement, one request each. 'expression': Bgee baseline (healthy, untreated) expression per species and " +
                "tissue. 'knockout': IMPC mouse loss-of-function phenotype.",
        ),
    species: z
        .array(z.enum(SUPPORTED_SPECIES))
        .min(1)
        .optional()
        .describe(
            "'expression' only. Default ['homo_sapiens','mus_musculus'] — the surrogate question. Add rat/dog/macaque when the cross-species comparison " +
                "is the point; dog and macaque coverage is thin, so expect empty entries.",
        ),
    minRank: z
        .enum(["absent", "low", "medium", "high"])
        .optional()
        .describe(
            "'expression' only. Drop tissues below this bucketed rank; default 'low' (drops only not-expressed). Use 'medium'/'high' for just the tissues " +
                "where the gene is abundant — the usual tissue-of-action question.",
        ),
    tissueLimit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(
            `'expression' only. Max tissues per species after minRank, highest expression first (default ${DEFAULTS.tissueLimit}, max 100). ` +
                "`tissueCount`/`tissuesAboveMinRank` give the pre-trim counts.",
        ),
    phenotypeLimit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(
            `'knockout' only. Max MP phenotype terms, best p-value first (default ${DEFAULTS.phenotypeLimit}, max 200). \`phenotypeCount\` gives the ` +
                "true total; `organSystems` is never trimmed, so the top-line picture survives.",
        ),
});

type PreclinicalOutput = {
    geneSymbol: string;
    expression?: ExpressionHalf;
    knockout?: KnockoutHalf;
};

function boundExpression(raw: Awaited<ReturnType<typeof getMultiSpeciesExpression>>, minRank: ExpressionRank, tissueLimit: number): ExpressionHalf {
    const floor = RANK_ORDER[minRank];
    return {
        humanEnsemblId: raw.humanEnsemblId,
        bySpecies: raw.bySpecies.map((entry) => {
            const aboveFloor = entry.tissues.filter((t) => RANK_ORDER[t.rank] >= floor);
            const ranked = [...aboveFloor].sort((a, b) => (b.expressionScore ?? 0) - (a.expressionScore ?? 0));
            return {
                species: entry.species,
                taxonId: entry.taxonId,
                ensemblId: entry.ensemblId,
                tissues: ranked.slice(0, tissueLimit),
                tissueCount: entry.tissues.length,
                tissuesAboveMinRank: aboveFloor.length,
            };
        }),
        notFound: raw.notFound,
    };
}

function boundKnockout(raw: Awaited<ReturnType<typeof getKoPhenotypeProfile>>, phenotypeLimit: number): KnockoutHalf {
    return {
        mouseMarkerSymbol: raw.mouseMarkerSymbol,
        mgiAccessionId: raw.mgiAccessionId,
        viability: raw.viability,
        viabilityCalls: raw.viabilityCalls,
        mpTerms: raw.mpTerms.slice(0, phenotypeLimit),
        organSystems: raw.organSystems,
        sexDimorphic: raw.sexDimorphic,
        phenotypeCount: raw.phenotypeCount,
        phenotypesTrimmed: raw.mpTerms.length > phenotypeLimit,
    };
}

export const genePreclinicalProfileTool = defineTool({
    id: "gene_preclinical_profile",
    description:
        "The in-vivo preclinical profile of ONE human gene — baseline expression (Bgee) and mouse-knockout phenotype (IMPC) in one call. Answers " +
        "tissue-of-action ('where does this target act?'), model-organism suitability ('is the mouse a fair surrogate?') and essentiality ('what happens " +
        "when this gene is lost?').\n" +
        "Expression is BASELINE (healthy, untreated) only — differential expression between conditions is the analysis pipeline's job, never this tool.\n" +
        "Output is trimmed by default (see `minRank`, `tissueLimit`, `phenotypeLimit`); the accompanying counts distinguish a trimmed list from a sparse one.\n" +
        "SPARSE OUTPUT IS VALID NO-DATA, not an error — do not retry. A null humanEnsemblId means the symbol did not resolve; a null mouseMarkerSymbol " +
        "with no phenotype terms means the gene has not been IMPC-phenotyped, which is common.",
    inputSchema,
    execute: async ({ geneSymbol, include, species, minRank, tissueLimit, phenotypeLimit }) => {
        const halves = include ?? ["expression", "knockout"];
        const wantExpression = halves.includes("expression");
        const wantKnockout = halves.includes("knockout");

        const [expressionRaw, knockoutRaw] = await Promise.all([
            wantExpression ? getMultiSpeciesExpression(geneSymbol, [...(species ?? DEFAULT_SPECIES)]) : Promise.resolve(null),
            wantKnockout ? getKoPhenotypeProfile(geneSymbol) : Promise.resolve(null),
        ]);

        const output: PreclinicalOutput = { geneSymbol };
        if (expressionRaw) {
            output.expression = boundExpression(expressionRaw, minRank ?? DEFAULTS.minRank, tissueLimit ?? DEFAULTS.tissueLimit);
        }
        if (knockoutRaw) {
            output.knockout = boundKnockout(knockoutRaw, phenotypeLimit ?? DEFAULTS.phenotypeLimit);
        }
        return ok(output);
    },
});
