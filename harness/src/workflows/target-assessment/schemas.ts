/**
 * Shared schemas for target-assessment workflow inter-step contracts.
 *
 * The workflow input/output schemas, the resolved-target shape used by
 * every Phase-1 collector, and the keyed Phase-1/2/3 bundle shapes.
 */

import { z } from "zod";
import { EvidenceItemSchema } from "@inflexa-ai/harness/contracts/target-dossier.js";
import { withCoverage } from "./coverage.js";

export const TargetAssessmentInputSchema = z.object({
    /** UUID of the target_assessments row already inserted by the trigger route. */
    assessmentId: z.string().uuid(),
    /** Free-form target identifier (gene symbol, alias, UniProt accession, ENSG, CHEMBL\d+). */
    target: z.string().min(1),
    /** Optional reviewer goal (carried into the dossier header). */
    goal: z.string().nullable().optional(),
    /** Organization id — used for scoping & billing. */
    organizationId: z.string(),
    /** Requesting user id (identity sub claim). */
    requestedBy: z.string(),
});
export type TargetAssessmentInput = z.infer<typeof TargetAssessmentInputSchema>;

export const ResolvedTargetSchema = z.object({
    assessmentId: z.string().uuid(),
    goal: z.string().nullable(),
    canonicalId: z.string(),
    canonicalOntology: z.enum(["hgnc", "ensembl"]),
    geneSymbol: z.string(),
    approvedName: z.string(),
    ids: z.object({
        hgnc: z.string().nullable(),
        ensembl: z.string().nullable(),
        uniprot: z.string().nullable(),
        chembl: z.string().nullable(),
        entrez: z.string().nullable(),
    }),
    synonyms: z.array(z.string()),
    proteinSynonyms: z.array(z.string()),
    proteinFamily: z.string().nullable(),
    resolutionCoverage: z.object({
        hgnc: z.boolean(),
        uniprot: z.boolean(),
        ensembl: z.boolean(),
        chembl: z.boolean(),
    }),
});
export type ResolvedTarget = z.infer<typeof ResolvedTargetSchema>;

// ── Phase-1 collector output schemas ─────────────────────────────────

const AssociationSchema = z.object({
    diseaseId: z.string(),
    diseaseName: z.string(),
    score: z.number(),
    geneticAssociationScore: z.number().nullable(),
    knownDrugScore: z.number().nullable(),
    literatureScore: z.number().nullable(),
    animalModelScore: z.number().nullable().default(null),
    somaticMutationScore: z.number().nullable().default(null),
    literaturePmids: z.array(z.string()).default([]),
});

export const OpenTargetsBundleSchema = z.object({
    ensemblId: z.string(),
    approvedSymbol: z.string(),
    approvedName: z.string(),
    tractability: z
        .object({
            smallMolecule: z.boolean().nullable(),
            antibody: z.boolean().nullable(),
            otherModalities: z.boolean().nullable(),
        })
        .nullable(),
    associations: z.array(AssociationSchema),
    safetyLiabilities: z.array(
        z.object({
            event: z.string(),
            biosamples: z.array(z.string()),
            effects: z.string().nullable(),
            source: z.string(),
        }),
    ),
    baselineExpression: z.array(
        z.object({
            tissueId: z.string(),
            tissueLabel: z.string(),
            organSystem: z.string().nullable(),
            rna: z.object({ value: z.number(), unit: z.string() }).nullable(),
            protein: z.object({ level: z.number().nullable() }).nullable(),
        }),
    ),
});
export type OpenTargetsBundle = z.infer<typeof OpenTargetsBundleSchema>;

export const ChemblModulatorsBundleSchema = z.object({
    targetChemblId: z.string().nullable(),
    modulators: z.array(
        z.object({
            moleculeChemblId: z.string(),
            parentChemblId: z.string().nullable(),
            preferredName: z.string().nullable(),
            maxPhase: z.number().nullable(),
            moleculeType: z.string().nullable(),
            firstApproval: z.number().nullable(),
            /** Present only for entries discovered via the activity-table secondary path. */
            evidence_source: z.literal("chembl_activity").optional(),
        }),
    ),
});
export type ChemblModulatorsBundle = z.infer<typeof ChemblModulatorsBundleSchema>;

export const CtgovInterventionSchema = z.object({
    name: z.string(),
    type: z.string().nullable(),
    description: z.string().nullable(),
    otherNames: z.array(z.string()),
});

export const CtgovTrialSchema = z.object({
    nctId: z.string(),
    title: z.string(),
    officialTitle: z.string().nullable(),
    status: z.string(),
    phase: z.string().nullable(),
    studyType: z.string().nullable(),
    primaryPurpose: z.string().nullable(),
    conditions: z.array(z.string()),
    interventions: z.array(z.string()),
    interventionDetails: z.array(CtgovInterventionSchema),
    enrollmentCount: z.number().nullable(),
    startDate: z.string().nullable(),
    primaryCompletionDate: z.string().nullable(),
    whyStopped: z.string().nullable(),
    briefSummary: z.string().nullable(),
    detailedDescription: z.string().nullable(),
    sponsor: z.string().nullable(),
    collection_query: z.string().optional(),
    collection_channel: z.enum(["target_symbol", "class_modulator", "therapeutic_program", "biomarker_context", "failed_intervention"]).optional(),
});

export const CtgovBundleSchema = z.object({
    active: z.array(CtgovTrialSchema),
    failed: z.array(CtgovTrialSchema),
});
export type CtgovBundle = z.infer<typeof CtgovBundleSchema>;

export const FaersByTargetBundleSchema = z.object({
    drugProbed: z.string(),
    totalReports: z.number().nullable(),
    topReactions: z.array(z.object({ reaction: z.string(), count: z.number() })),
    seriousness: z
        .object({
            totalReports: z.number(),
            fatalCount: z.number(),
            hospitalizationCount: z.number(),
            lifeThreateningCount: z.number(),
            disablingCount: z.number(),
            congenitalAnomalyCount: z.number().default(0),
            otherSeriousCount: z.number().default(0),
        })
        .nullable(),
});
export type FaersByTargetBundle = z.infer<typeof FaersByTargetBundleSchema>;

export const ExpressionHumanBundleSchema = z.object({
    source: z.enum(["gtex", "hpa_consensus", "hpa_rna_tissue"]),
    unit: z.enum(["tpm", "ntpm", "consensus_normalized"]),
    normalization_notes: z.string().min(1),
    tissues: z.array(
        z.object({
            tissueLabel: z.string(),
            organSystem: z.string().nullable(),
            value: z.number().nullable(),
            protein: z.number().nullable(),
        }),
    ),
});
export type ExpressionHumanBundle = z.infer<typeof ExpressionHumanBundleSchema>;

export const ExpressionMultiSpeciesBundleSchema = z.object({
    geneSymbol: z.string(),
    humanEnsemblId: z.string().nullable(),
    bySpecies: z.array(
        z.object({
            species: z.string(),
            taxonId: z.number(),
            ensemblId: z.string(),
            source: z.string(),
            unit: z.string(),
            normalization_notes: z.string(),
            tissues: z.array(
                z.object({
                    tissue: z.string(),
                    rank: z.enum(["absent", "low", "medium", "high"]),
                    expressionScore: z.number().nullable(),
                }),
            ),
        }),
    ),
    notFound: z.array(z.string()),
});
export type ExpressionMultiSpeciesBundle = z.infer<typeof ExpressionMultiSpeciesBundleSchema>;

export const ClinvarBundleSchema = z.object({
    totalFound: z.number(),
    variants: z.array(
        z.object({
            variationId: z.string(),
            title: z.string(),
            clinicalSignificance: z.string(),
            reviewStatus: z.string(),
            conditions: z.array(z.string()),
            molecularConsequence: z.string(),
            accession: z.string(),
        }),
    ),
});
export type ClinvarBundle = z.infer<typeof ClinvarBundleSchema>;

export const CbioportalBundleSchema = z.object({
    entrezGeneId: z.number().nullable(),
    rows: z.array(
        z.object({
            cancerTypeId: z.string(),
            cancerTypeName: z.string(),
            totalSamples: z.number(),
            mutatedSamples: z.number(),
            frequency: z.number(),
            studies: z.array(z.string()),
        }),
    ),
});
export type CbioportalBundle = z.infer<typeof CbioportalBundleSchema>;

export const ImpcBundleSchema = z.object({
    mouseMarkerSymbol: z.string().nullable(),
    mgiAccessionId: z.string().nullable(),
    viability: z.enum(["lethal_pre_weaning", "subviable", "viable"]).nullable(),
    viabilityCalls: z.array(
        z.object({
            zygosity: z.string(),
            parameterStableId: z.string(),
            mpTerm: z.object({ id: z.string(), name: z.string() }).nullable(),
        }),
    ),
    mpTerms: z.array(z.object({ id: z.string(), term: z.string(), bestPValue: z.number().nullable() })),
    organSystems: z.array(z.string()),
    sexDimorphic: z.boolean(),
    phenotypeCount: z.number(),
});
export type ImpcBundle = z.infer<typeof ImpcBundleSchema>;

export const PubmedIndexBundleSchema = z.object({
    totalFound: z.number(),
    topPmids: z.array(z.string()),
    results: z.array(
        z.object({
            pmid: z.string(),
            title: z.string(),
            journal: z.string(),
            year: z.string(),
            authors: z.string(),
        }),
    ),
});
export type PubmedIndexBundle = z.infer<typeof PubmedIndexBundleSchema>;

export const PathwaysBundleSchema = z.object({
    pathways: z.array(
        z.object({
            id: z.string(),
            name: z.string(),
            source: z.enum(["kegg", "reactome"]),
            url: z.string().optional(),
            entity_uniprots: z.array(z.string()).optional(),
            metadata: z.object({ species_present: z.array(z.string()).optional() }).optional(),
        }),
    ),
});
export type PathwaysBundle = z.infer<typeof PathwaysBundleSchema>;

export const StringPpiBundleSchema = z.object({
    partners: z.array(
        z.object({
            proteinA: z.string(),
            proteinB: z.string(),
            score: z.number(),
            experimentalScore: z.number().optional(),
            databaseScore: z.number().optional(),
            textminingScore: z.number().optional(),
        }),
    ),
});
export type StringPpiBundle = z.infer<typeof StringPpiBundleSchema>;

/**
 * Heterodimer / receptor-accessory complex inventory for the assessment
 * target, sourced from IUPHAR Guide to Pharmacology. Drives runtime
 * heterodimer-name detection (no hardcoded RAMP/MRAP/RGS regex) and the
 * obligate-cofactor supplement in the off-target panel.
 */
export const FamilyComplexesBundleSchema = z.object({
    primaryTargetGene: z.string(),
    primaryTargetUniprot: z.string().nullable(),
    accessoryProteinNames: z.array(z.string()),
    complexes: z.array(
        z.object({
            complexName: z.string(),
            complexId: z.number().nullable(),
            accessoryNames: z.array(z.string()),
            subunitNames: z.array(z.string()),
        }),
    ),
});
export type FamilyComplexesBundle = z.infer<typeof FamilyComplexesBundleSchema>;

export const TherapeuticProgramsBundleSchema = z.object({
    programs: z.array(
        z.object({
            programId: z.string(),
            name: z.string(),
            targetSymbol: z.string(),
            targetUniprot: z.string().nullable(),
            modality: z.string(),
            sponsor: z.string().nullable(),
            mechanism: z.string(),
            status: z.string(),
            nctIds: z.array(z.string()),
            pmids: z.array(z.string()),
            evidence: z.array(EvidenceItemSchema),
            confidence: z.enum(["high", "medium", "low"]),
        }),
    ),
});
export type TherapeuticProgramsBundle = z.infer<typeof TherapeuticProgramsBundleSchema>;

// ── Phase-1 keyed bundle (output of phase1Aggregate) ─────────────────

export const Phase1BundleSchema = z.object({
    resolved: ResolvedTargetSchema,
    collectors: z.object({
        opentargets: withCoverage(OpenTargetsBundleSchema),
        chemblModulators: withCoverage(ChemblModulatorsBundleSchema),
        ctgov: withCoverage(CtgovBundleSchema),
        faersByTarget: withCoverage(FaersByTargetBundleSchema),
        expressionHuman: withCoverage(ExpressionHumanBundleSchema),
        expressionMultiSpecies: withCoverage(ExpressionMultiSpeciesBundleSchema),
        clinvar: withCoverage(ClinvarBundleSchema),
        cbioportal: withCoverage(CbioportalBundleSchema),
        impc: withCoverage(ImpcBundleSchema),
        pubmedIndex: withCoverage(PubmedIndexBundleSchema),
        pathways: withCoverage(PathwaysBundleSchema),
        stringPpi: withCoverage(StringPpiBundleSchema),
        familyComplexes: withCoverage(FamilyComplexesBundleSchema),
        therapeuticPrograms: withCoverage(TherapeuticProgramsBundleSchema).optional(),
    }),
});
export type Phase1Bundle = z.infer<typeof Phase1BundleSchema>;
