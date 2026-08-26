/**
 * genePreclinicalProfile — the in-vivo picture of one gene: where it is
 * expressed at baseline (Bgee), what removing it does to a mouse (IMPC), and
 * what people who carry variation in it present with (Monarch, HPO), behind
 * one `include`.
 *
 * The three halves share an input exactly — ONE human gene symbol, with the
 * per-species orthologs and the gene curie resolved internally — and answer one
 * question between them: is this target expressed where it needs to act, is a
 * model organism a fair surrogate for it, and what does losing it do to a
 * person. The first two were two tools that were called as a pair.
 *
 * No source caps its own output: Bgee returns every annotated tissue per
 * species, IMPC every significant phenotype term, and Monarch every curated
 * HPO annotation, so each half is trimmed here rather than in the clients — the
 * target-assessment collectors read the same clients and legitimately want full
 * fidelity for the dossier.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { SUPPORTED_SPECIES, getMultiSpeciesExpression, type ExpressionRank, type SupportedSpecies, type TissueRow } from "../lib/bgee-client.js";
import { resolveTarget } from "../lib/identifier-resolver.js";
import { getKoPhenotypeProfile, type MpTerm, type ViabilityCall, type ViabilityCategory } from "../lib/impc-client.js";
import { getGenePhenotypeProfile, type MonarchPhenotypeAssociation } from "../lib/monarch-client.js";

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

/**
 * One curated human phenotype. The HPO ancestor closure of the source record
 * is dropped here: it exists so a dossier collector can resolve an organ system
 * by identifier, and it runs to hundreds of ids that a reader never uses.
 */
type HumanPhenotypeTerm = Omit<MonarchPhenotypeAssociation, "ancestorIds">;

interface HumanPhenotypeHalf {
    /** The curie Monarch was queried by, e.g. `HGNC:1100`; null when the symbol did not anchor on HGNC. */
    geneCurie: string | null;
    hpoTerms: HumanPhenotypeTerm[];
    /** Curated HPO annotations before `phenotypeLimit`. */
    phenotypeCount: number;
    /** True when `phenotypeLimit` trimmed `hpoTerms`; `phenotypeCount` is the real total. */
    phenotypesTrimmed: boolean;
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
        .array(z.enum(["expression", "knockout", "phenotypes"]))
        .min(1)
        .optional()
        .describe(
            "Default ['expression','knockout'] — two sides of one judgement, one request each. 'expression': Bgee baseline (healthy, untreated) " +
                "expression per species and tissue. 'knockout': IMPC mouse loss-of-function phenotype. 'phenotypes': the HUMAN counterpart — the curated " +
                "HPO phenotypes that Monarch attributes to variation in this gene, from HPOA, OMIM and Orphanet, each with its PMIDs and the disease it " +
                "was annotated under. Ask for it explicitly, and pair it with 'knockout' when the question is whether the mouse recapitulates the person.",
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
            `'knockout' and 'phenotypes'. Max phenotype terms per half — MP terms best p-value first, HPO terms in curation order (default ` +
                `${DEFAULTS.phenotypeLimit}, max 200). Each half reports its own \`phenotypeCount\` for the true total; \`organSystems\` is never ` +
                "trimmed, so the top-line knockout picture survives.",
        ),
});

type PreclinicalOutput = {
    geneSymbol: string;
    expression?: ExpressionHalf;
    knockout?: KnockoutHalf;
    phenotypes?: HumanPhenotypeHalf;
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

/**
 * Anchor the symbol on HGNC and read the curated human phenotypes. A symbol
 * that anchors on no HGNC id gives a null curie and an empty term list, which
 * is absence and not a failure.
 */
async function fetchHumanPhenotypes(geneSymbol: string, phenotypeLimit: number): Promise<HumanPhenotypeHalf> {
    let geneCurie: string | null;
    try {
        geneCurie = (await resolveTarget(geneSymbol)).ids.hgnc;
    } catch {
        geneCurie = null;
    }
    if (!geneCurie) return { geneCurie: null, hpoTerms: [], phenotypeCount: 0, phenotypesTrimmed: false };

    const profile = await getGenePhenotypeProfile(geneCurie);
    return {
        geneCurie: profile.geneCurie,
        hpoTerms: profile.phenotypes.slice(0, phenotypeLimit).map(({ ancestorIds: _ancestorIds, ...term }) => term),
        phenotypeCount: profile.phenotypes.length,
        phenotypesTrimmed: profile.phenotypes.length > phenotypeLimit,
    };
}

export const genePreclinicalProfileTool = defineTool({
    id: "gene_preclinical_profile",
    description:
        "The in-vivo profile of ONE human gene across three corpora in one call — baseline expression from Bgee, the mouse-knockout phenotype from IMPC " +
        "(the International Mouse Phenotyping Consortium), and the curated human phenotypes from the Monarch Initiative (HPO terms sourced from HPOA, " +
        "OMIM and Orphanet). Answers tissue-of-action ('where does this target act?'), model-organism suitability ('is the mouse a fair surrogate?'), " +
        "essentiality ('what happens when this gene is lost?') and the human read-out ('what do people carrying variation in it present with?').\n" +
        "Expression is BASELINE (healthy, untreated) only — differential expression between conditions is the analysis pipeline's job, never this tool.\n" +
        "ACCEPTED IDENTIFIERS: one HUMAN gene symbol, e.g. 'BRCA1'. The ENSG, the per-species orthologs and the HGNC curie are resolved for you; an " +
        "Ensembl ID, a mouse symbol and an MGI ID are not accepted here — put those through search_gene first.\n" +
        "Output is trimmed by default (see `minRank`, `tissueLimit`, `phenotypeLimit`); the accompanying counts distinguish a trimmed list from a sparse one.\n" +
        "SPARSE OUTPUT IS VALID NO-DATA, not an error — do not retry. A null humanEnsemblId means the symbol did not resolve; a null mouseMarkerSymbol " +
        "with no phenotype terms means the gene has not been IMPC-phenotyped, which is common; an empty hpoTerms list means Monarch curates no human " +
        "phenotype for the gene, and a null geneCurie means the symbol anchored on no HGNC id.",
    inputSchema,
    describeCall: "none",
    execute: async ({ geneSymbol, include, species, minRank, tissueLimit, phenotypeLimit }) => {
        const halves = include ?? ["expression", "knockout"];
        const wantExpression = halves.includes("expression");
        const wantKnockout = halves.includes("knockout");
        const wantPhenotypes = halves.includes("phenotypes");
        const termLimit = phenotypeLimit ?? DEFAULTS.phenotypeLimit;

        const [expressionRaw, knockoutRaw, phenotypesHalf] = await Promise.all([
            wantExpression ? getMultiSpeciesExpression(geneSymbol, [...(species ?? DEFAULT_SPECIES)]) : Promise.resolve(null),
            wantKnockout ? getKoPhenotypeProfile(geneSymbol) : Promise.resolve(null),
            wantPhenotypes ? fetchHumanPhenotypes(geneSymbol, termLimit) : Promise.resolve(null),
        ]);

        const output: PreclinicalOutput = { geneSymbol };
        if (expressionRaw) {
            output.expression = boundExpression(expressionRaw, minRank ?? DEFAULTS.minRank, tissueLimit ?? DEFAULTS.tissueLimit);
        }
        if (knockoutRaw) {
            output.knockout = boundKnockout(knockoutRaw, termLimit);
        }
        if (phenotypesHalf) {
            output.phenotypes = phenotypesHalf;
        }
        return ok(output);
    },
});
