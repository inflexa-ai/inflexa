/**
 * Phase 1 aggregator — schema definitions retained for downstream
 * type-checking. The DBOS workflow assembles the Phase-1 bundle inline.
 */

import { z } from "zod";
import { Phase1BundleSchema } from "../schemas.js";
import { withCoverage } from "../coverage.js";
import {
    OpenTargetsBundleSchema,
    ChemblModulatorsBundleSchema,
    CtgovBundleSchema,
    FaersByTargetBundleSchema,
    ExpressionHumanBundleSchema,
    ExpressionMultiSpeciesBundleSchema,
    ClinvarBundleSchema,
    CbioportalBundleSchema,
    ImpcBundleSchema,
    PubmedIndexBundleSchema,
    PathwaysBundleSchema,
    StringPpiBundleSchema,
    FamilyComplexesBundleSchema,
    TherapeuticProgramsBundleSchema,
} from "../schemas.js";

export const Phase1AggregateInputSchema = z.object({
    "collector-opentargets": withCoverage(OpenTargetsBundleSchema),
    "collector-chembl-modulators": withCoverage(ChemblModulatorsBundleSchema),
    "collector-ctgov": withCoverage(CtgovBundleSchema),
    "collector-faers-by-target": withCoverage(FaersByTargetBundleSchema),
    "collector-expression-human": withCoverage(ExpressionHumanBundleSchema),
    "collector-expression-multi-species": withCoverage(ExpressionMultiSpeciesBundleSchema),
    "collector-clinvar": withCoverage(ClinvarBundleSchema),
    "collector-cbioportal": withCoverage(CbioportalBundleSchema),
    "collector-impc": withCoverage(ImpcBundleSchema),
    "collector-pubmed-index": withCoverage(PubmedIndexBundleSchema),
    "collector-pathways": withCoverage(PathwaysBundleSchema),
    "collector-string-ppi": withCoverage(StringPpiBundleSchema),
    "collector-family-complexes": withCoverage(FamilyComplexesBundleSchema),
    "collector-therapeutic-programs": withCoverage(TherapeuticProgramsBundleSchema),
});

export const phase1OutputSchema = Phase1BundleSchema;
