/**
 * Phase-1 collector functions for the harness DBOS workflow.
 *
 * Each collector is a pure async function `(input: ResolvedTarget) =>
 * Promise<CoverageBundle>`. Bodies: try/catch wraps a `withHost`-
 * guarded tool-client call (or a couple in parallel) and returns
 * `{coverage: "available", data}` on success or `{coverage: "queried_no_data",
 * error}` on failure. A handful of collectors return
 * `{coverage: "not_loaded", reason}` when a required upstream identifier is
 * missing — that signals "we never tried" vs. "we tried and got nothing."
 *
 * No collector throws — coverage is the failure mode. The DBOS workflow body
 * wraps each call in `DBOS.runStep({name: "ta-collector:{collectorId}"})` so
 * recovery on a fresh replica replays the cached coverage envelope instead
 * of re-issuing the HTTP call.
 *
 * No `deps` parameter is threaded through today (collectors call the tool
 * clients directly) — every external request goes through the global
 * `withHost(...)` semaphore. The function signature reserves the future
 * `deps` slot for test injection without churning callers.
 */

import { withHost } from "../../../lib/host-concurrency.js";

/** Per-run context threaded to collectors that hit keyed external APIs. */
export interface CollectorCtx {
    readonly ncbiApiKey?: string;
}

import type { SerializedError } from "../coverage.js";
import type {
    CbioportalBundle,
    ChemblModulatorsBundle,
    ClinvarBundle,
    CtgovBundle,
    ExpressionHumanBundle,
    ExpressionMultiSpeciesBundle,
    FaersByTargetBundle,
    FamilyComplexesBundle,
    ImpcBundle,
    OpenTargetsBundle,
    PathwaysBundle,
    PubmedIndexBundle,
    ResolvedTarget,
    StringPpiBundle,
    TherapeuticProgramsBundle,
} from "../schemas.js";

import { getMultiSpeciesExpression } from "../../../tools/lib/bgee-client.js";
import { getSomaticMutationFrequencies } from "../../../tools/lib/cbioportal-client.js";
import { getModulatorsViaActivity, getTargetModulators } from "../../../tools/lib/chembl-client.js";
import { searchFailedTrials, searchTrialsForTarget } from "../../../tools/lib/clinical-trials-client.js";
import { filterInformative, searchClinvar } from "../../../tools/lib/clinvar-client.js";
import { getKoPhenotypeProfile } from "../../../tools/lib/impc-client.js";
import { getFamilyHeterodimers } from "../../../tools/lib/iuphar-client.js";
import { getFaersByDrug, getFaersSeriousness } from "../../../tools/lib/openfda-client.js";
import { getBaselineExpression, getTargetSafetyLiabilities, searchTargetAssociations } from "../../../tools/lib/opentargets-client.js";
import { getPathwayMemberships } from "../../../tools/lib/pathway-client.js";
import { searchPubmed } from "../../../tools/lib/pubmed-client.js";
import { getInteractionPartners } from "../../../tools/lib/string-client.js";
import { findTherapeuticProgramsForTarget } from "../lib/therapeutic-programs.js";
import { dedupPathwaysAcrossSpecies, type PathwayRow } from "../steps/collectors/pathways.js";

// ── Coverage envelope shapes ─────────────────────────────────────────

type CoverageAvailable<T> = { coverage: "available"; data: T };
type CoverageQueriedNoData = {
    coverage: "queried_no_data";
    error?: SerializedError;
};
type CoverageNotLoaded = { coverage: "not_loaded"; reason?: string };
type CoverageEnvelope<T> = CoverageAvailable<T> | CoverageQueriedNoData | CoverageNotLoaded;

function fail(err: unknown): CoverageQueriedNoData {
    return {
        coverage: "queried_no_data",
        error: { message: err instanceof Error ? err.message : String(err) },
    };
}

// ── 1. cBioPortal ────────────────────────────────────────────────────

export async function collectCbioportal(input: ResolvedTarget): Promise<CoverageEnvelope<CbioportalBundle>> {
    try {
        const result = await withHost("cbioportal", () => getSomaticMutationFrequencies(input.geneSymbol));
        if (result.entrezGeneId == null) {
            return {
                coverage: "queried_no_data",
                error: {
                    message: `cBioPortal could not resolve Entrez id for ${input.geneSymbol}`,
                },
            };
        }
        return { coverage: "available", data: result };
    } catch (err) {
        return fail(err);
    }
}

// ── 2. ChEMBL modulators ─────────────────────────────────────────────

export async function collectChemblModulators(input: ResolvedTarget): Promise<CoverageEnvelope<ChemblModulatorsBundle>> {
    const chemblId = input.ids.chembl;
    if (!chemblId) {
        return { coverage: "not_loaded", reason: "no ChEMBL target id resolved" };
    }
    try {
        const primaryRows = await withHost("chembl", () => getTargetModulators(chemblId, { minPhase: 2, limit: 200 }));
        const activityRows = await withHost("chembl", () =>
            getModulatorsViaActivity({
                target_chembl_id: chemblId,
                max_phase_min: 2,
                molecule_type: "Small molecule",
            }),
        );
        const primaryIds = new Set(primaryRows.map((m) => m.moleculeChemblId));
        const novelActivityRows = activityRows
            .filter((m) => !primaryIds.has(m.moleculeChemblId))
            .map((m) => ({ ...m, evidence_source: "chembl_activity" as const }));
        const modulators = [...primaryRows, ...novelActivityRows];
        return {
            coverage: "available",
            data: { targetChemblId: chemblId, modulators },
        };
    } catch (err) {
        return fail(err);
    }
}

// ── 3. ClinVar ───────────────────────────────────────────────────────

export async function collectClinvar(input: ResolvedTarget, ctx: CollectorCtx): Promise<CoverageEnvelope<ClinvarBundle>> {
    try {
        const result = await withHost("ncbi", () => searchClinvar(ctx.ncbiApiKey, input.geneSymbol, { limit: 200 }));
        const filtered = filterInformative(result.variants);
        return {
            coverage: "available",
            data: {
                totalFound: result.totalFound,
                variants: filtered.map((v) => ({
                    variationId: v.variationId,
                    title: v.title,
                    clinicalSignificance: v.clinicalSignificance,
                    reviewStatus: v.reviewStatus,
                    conditions: v.conditions,
                    molecularConsequence: v.molecularConsequence,
                    accession: v.accession,
                })),
            },
        };
    } catch (err) {
        return fail(err);
    }
}

// ── 4. ClinicalTrials.gov ────────────────────────────────────────────

function tagTrials<T extends { nctId: string }>(
    trials: T[],
    collection_query: string,
    collection_channel: "target_symbol" | "failed_intervention",
): Array<T & { collection_query: string; collection_channel: typeof collection_channel }> {
    return trials.map((trial) => ({
        ...trial,
        collection_query,
        collection_channel,
    }));
}

export async function collectCtgov(input: ResolvedTarget): Promise<CoverageEnvelope<CtgovBundle>> {
    try {
        const [active, failed] = await Promise.all([
            withHost("ctgov", () => searchTrialsForTarget(input.geneSymbol, { limit: 100 })),
            withHost("ctgov", () => searchFailedTrials(input.geneSymbol, 100)),
        ]);
        return {
            coverage: "available",
            data: {
                active: tagTrials(active.trials, input.geneSymbol, "target_symbol"),
                failed: tagTrials(failed.trials, input.geneSymbol, "failed_intervention"),
            },
        };
    } catch (err) {
        return fail(err);
    }
}

// ── 5. Expression — human (Open Targets baseline) ────────────────────

export async function collectExpressionHuman(input: ResolvedTarget): Promise<CoverageEnvelope<ExpressionHumanBundle>> {
    const ensemblId = input.ids.ensembl;
    if (!ensemblId) {
        return { coverage: "not_loaded", reason: "no Ensembl id resolved" };
    }
    try {
        const expressions = await withHost("opentargets", () => getBaselineExpression(ensemblId));
        if (expressions.length === 0) {
            return {
                coverage: "queried_no_data",
                error: {
                    message: `Open Targets returned no baseline expression for ${ensemblId}`,
                },
            };
        }
        const tissues = expressions.map((e) => ({
            tissueLabel: e.tissueLabel,
            organSystem: e.organSystem,
            value: e.rna?.value ?? null,
            protein: e.protein?.level ?? null,
        }));
        return {
            coverage: "available",
            data: {
                source: "hpa_consensus" as const,
                unit: "consensus_normalized" as const,
                normalization_notes: "Open Targets consensus expression (HPA RNA tissue, TMM-normalized nTPM across samples)",
                tissues,
            },
        };
    } catch (err) {
        return fail(err);
    }
}

// ── 6. Expression — multi-species (Bgee) ─────────────────────────────

export async function collectExpressionMultiSpecies(input: ResolvedTarget): Promise<CoverageEnvelope<ExpressionMultiSpeciesBundle>> {
    try {
        const result = await withHost("bgee", () => getMultiSpeciesExpression(input.geneSymbol));
        if (!result.humanEnsemblId) {
            return {
                coverage: "queried_no_data",
                error: {
                    message: `Bgee could not resolve Ensembl id for ${input.geneSymbol}`,
                },
            };
        }
        return {
            coverage: "available",
            data: {
                geneSymbol: result.geneSymbol,
                humanEnsemblId: result.humanEnsemblId,
                bySpecies: result.bySpecies.map((s) => ({
                    species: s.species,
                    taxonId: s.taxonId,
                    ensemblId: s.ensemblId,
                    source: "bgee",
                    unit: "expression_score",
                    normalization_notes: "Bgee expression score (0–100) bucketed into absent/low/medium/high; not a transcript-abundance unit",
                    tissues: s.tissues.map((t) => ({
                        tissue: t.tissue,
                        rank: t.rank,
                        expressionScore: t.expressionScore,
                    })),
                })),
                notFound: result.notFound,
            },
        };
    } catch (err) {
        return fail(err);
    }
}

// ── 7. FAERS by target ───────────────────────────────────────────────

export async function collectFaersByTarget(input: ResolvedTarget): Promise<CoverageEnvelope<FaersByTargetBundle>> {
    const probe = input.geneSymbol;
    try {
        const [byDrug, seriousness] = await Promise.all([
            withHost("openfda", () => getFaersByDrug(probe, { limit: 25 })),
            withHost("openfda", () => getFaersSeriousness(probe)),
        ]);
        const total = byDrug.totalReports ?? 0;
        if (total === 0 && byDrug.adverseEvents.length === 0) {
            return {
                coverage: "queried_no_data",
                error: { message: `FAERS returned no reports for symbol ${probe}` },
            };
        }
        return {
            coverage: "available",
            data: {
                drugProbed: probe,
                totalReports: byDrug.totalReports ?? null,
                topReactions: byDrug.adverseEvents,
                seriousness,
            },
        };
    } catch (err) {
        return fail(err);
    }
}

// ── 8. Family complexes (IUPHAR) ─────────────────────────────────────

export async function collectFamilyComplexes(input: ResolvedTarget): Promise<CoverageEnvelope<FamilyComplexesBundle>> {
    const geneSymbol = input.geneSymbol;
    const uniprot = input.ids.uniprot;
    const lookup = uniprot ?? geneSymbol;
    if (!lookup) {
        return {
            coverage: "not_loaded",
            reason: "no gene symbol or UniProt accession",
        };
    }
    try {
        const heterodimers = await withHost("iuphar", () => getFamilyHeterodimers(lookup));
        if (heterodimers.length === 0) {
            return {
                coverage: "queried_no_data",
                error: {
                    message: `IUPHAR returned no heterodimer complexes for ${lookup}`,
                },
            };
        }
        const accessorySet = new Set<string>();
        const complexes = heterodimers.map((h) => {
            const accessoryNames = h.accessories.map((a) => a.name).filter(Boolean);
            for (const n of accessoryNames) accessorySet.add(n);
            return {
                complexName: h.complex.name,
                complexId: h.complex.targetId,
                accessoryNames,
                subunitNames: h.subunits.map((s) => s.name).filter(Boolean),
            };
        });
        return {
            coverage: "available",
            data: {
                primaryTargetGene: geneSymbol,
                primaryTargetUniprot: uniprot,
                accessoryProteinNames: [...accessorySet].sort(),
                complexes,
            },
        };
    } catch (err) {
        return fail(err);
    }
}

// ── 9. IMPC ───────────────────────────────────────────────────────────

export async function collectImpc(input: ResolvedTarget): Promise<CoverageEnvelope<ImpcBundle>> {
    try {
        const profile = await withHost("ncbi", () => getKoPhenotypeProfile(input.geneSymbol));
        if (!profile.mouseMarkerSymbol) {
            return {
                coverage: "queried_no_data",
                error: {
                    message: `IMPC has no mouse marker for ${input.geneSymbol}`,
                },
            };
        }
        return {
            coverage: "available",
            data: {
                mouseMarkerSymbol: profile.mouseMarkerSymbol,
                mgiAccessionId: profile.mgiAccessionId,
                viability: profile.viability,
                viabilityCalls: profile.viabilityCalls,
                mpTerms: profile.mpTerms,
                organSystems: profile.organSystems,
                sexDimorphic: profile.sexDimorphic,
                phenotypeCount: profile.phenotypeCount,
            },
        };
    } catch (err) {
        return fail(err);
    }
}

// ── 10. Open Targets ─────────────────────────────────────────────────

export async function collectOpenTargets(input: ResolvedTarget): Promise<CoverageEnvelope<OpenTargetsBundle>> {
    const ensemblId = input.ids.ensembl;
    if (!ensemblId) {
        return { coverage: "not_loaded", reason: "no Ensembl id resolved" };
    }
    try {
        const [info, safety, expression] = await Promise.all([
            withHost("opentargets", () => searchTargetAssociations(ensemblId, 50)),
            withHost("opentargets", () => getTargetSafetyLiabilities(ensemblId)),
            withHost("opentargets", () => getBaselineExpression(ensemblId)),
        ]);
        if (!info) {
            return {
                coverage: "queried_no_data",
                error: { message: `no Open Targets entry for ${ensemblId}` },
            };
        }
        return {
            coverage: "available",
            data: {
                ensemblId: info.ensemblId,
                approvedSymbol: info.approvedSymbol,
                approvedName: info.approvedName,
                tractability: info.tractability,
                associations: info.associations,
                safetyLiabilities: safety?.safetyLiabilities ?? [],
                baselineExpression: expression,
            },
        };
    } catch (err) {
        return fail(err);
    }
}

// ── 11. Pathways (Reactome + KEGG via the unified client) ────────────

export async function collectPathways(input: ResolvedTarget): Promise<CoverageEnvelope<PathwaysBundle>> {
    try {
        const raw = await withHost("reactome", () => getPathwayMemberships(input.geneSymbol));
        const rows: PathwayRow[] = raw.map((p) => ({
            id: p.id,
            name: p.name,
            source: p.source,
            url: p.url ?? "",
            entity_uniprots: p.entity_uniprots,
        }));
        const cleaned = dedupPathwaysAcrossSpecies(rows, {
            geneSymbolEchoFilter: input.geneSymbol,
            assessmentUniprot: input.ids.uniprot ?? undefined,
        });
        if (cleaned.length === 0) {
            return {
                coverage: "queried_no_data",
                error: {
                    message: `KEGG and Reactome returned no pathways for ${input.geneSymbol}`,
                },
            };
        }
        return { coverage: "available", data: { pathways: cleaned } };
    } catch (err) {
        return fail(err);
    }
}

// ── 12. PubMed index ─────────────────────────────────────────────────

export async function collectPubmedIndex(input: ResolvedTarget, ctx: CollectorCtx): Promise<CoverageEnvelope<PubmedIndexBundle>> {
    const query = `"${input.geneSymbol}"[Gene]`;
    try {
        const result = await withHost("ncbi", () =>
            searchPubmed(ctx.ncbiApiKey, query, {
                maxResults: 50,
                sort: "relevance",
            }),
        );
        if (result.totalFound === 0) {
            return {
                coverage: "queried_no_data",
                error: { message: `PubMed returned no hits for ${query}` },
            };
        }
        return {
            coverage: "available",
            data: {
                totalFound: result.totalFound,
                topPmids: result.results.map((r) => r.pmid),
                results: result.results,
            },
        };
    } catch (err) {
        return fail(err);
    }
}

// ── 13. STRING PPI ───────────────────────────────────────────────────

export async function collectStringPpi(input: ResolvedTarget): Promise<CoverageEnvelope<StringPpiBundle>> {
    try {
        const partners = await withHost("string", () =>
            getInteractionPartners([input.geneSymbol], {
                species: 9606,
                minScore: 400,
                limit: 50,
            }),
        );
        if (partners.length === 0) {
            return {
                coverage: "queried_no_data",
                error: {
                    message: `STRING returned no partners for ${input.geneSymbol}`,
                },
            };
        }
        return { coverage: "available", data: { partners } };
    } catch (err) {
        return fail(err);
    }
}

// ── 14. Therapeutic programs (non-ChEMBL curated set) ────────────────

export async function collectTherapeuticPrograms(input: ResolvedTarget): Promise<CoverageEnvelope<TherapeuticProgramsBundle>> {
    const programs = findTherapeuticProgramsForTarget({
        geneSymbol: input.geneSymbol,
        uniprot: input.ids.uniprot ?? null,
    });
    if (programs.length === 0) {
        return {
            coverage: "queried_no_data",
            error: { message: "no non-ChEMBL therapeutic programs registered" },
        };
    }
    return { coverage: "available", data: { programs } };
}

// ── Manifest ─────────────────────────────────────────────────────────

/**
 * Stable id used as the durable-step name suffix —
 * `ta-collector:{collectorId}`. The DBOS workflow body iterates this
 * manifest so adding a collector is one entry here + one new exported
 * function above, with no scheduler edits.
 */
export const COLLECTOR_MANIFEST = [
    { id: "cbioportal", run: collectCbioportal },
    { id: "chembl-modulators", run: collectChemblModulators },
    { id: "clinvar", run: collectClinvar },
    { id: "ctgov", run: collectCtgov },
    { id: "expression-human", run: collectExpressionHuman },
    { id: "expression-multi-species", run: collectExpressionMultiSpecies },
    { id: "faers-by-target", run: collectFaersByTarget },
    { id: "family-complexes", run: collectFamilyComplexes },
    { id: "impc", run: collectImpc },
    { id: "opentargets", run: collectOpenTargets },
    { id: "pathways", run: collectPathways },
    { id: "pubmed-index", run: collectPubmedIndex },
    { id: "string-ppi", run: collectStringPpi },
    { id: "therapeutic-programs", run: collectTherapeuticPrograms },
] as const;

export type CollectorId = (typeof COLLECTOR_MANIFEST)[number]["id"];
