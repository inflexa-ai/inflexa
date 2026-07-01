import { z } from "zod";

export const ORGAN_SYSTEMS = ["cardiac", "hepatic", "renal", "cns", "hematologic", "gi", "respiratory", "metabolic", "immune"] as const;

export const SEVERITIES = ["high", "medium", "low"] as const;

export type OrganSystem = (typeof ORGAN_SYSTEMS)[number];
export type Severity = (typeof SEVERITIES)[number];

export const CHEMBL_RE = /^CHEMBL\d+$/;
// UniProt 6-char accession: letter (any A-Z, covering A-N, O, P, Q, R-Z sub-families),
// followed by a digit, three alphanumerics, and a final digit.
export const UNIPROT_RE = /^[A-Z][0-9][A-Z0-9]{3}[0-9]$/;

const ChemblIdSchema = z.string().regex(CHEMBL_RE, "must match CHEMBL\\d+");
const GeneSymbolSchema = z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$/, "must be HGNC-style uppercase");
const UniprotSchema = z.string().regex(UNIPROT_RE, "must be a 6-char UniProt accession");
const EnsemblGeneSchema = z.string().regex(/^ENSG\d{11}$/, "must match ENSG\\d{11}");
const ReferenceSchema = z.string().regex(/^(PMID:\d+|DOI:.+)$/, "must be PMID:<digits> or DOI:<doi>");
const IsoDateSchema = z.string().date();

export const SafetyTargetSchema = z.object({
    chembl_id: ChemblIdSchema,
    gene_symbol: GeneSymbolSchema,
    uniprot: UniprotSchema,
    ensembl_gene_id: EnsemblGeneSchema.optional(),
    name: z.string().min(1).max(120),
    organ_system: z.enum(ORGAN_SYSTEMS),
    clinical_consequence: z.string().min(1).max(200),
    severity: z.enum(SEVERITIES),
    references: z.array(ReferenceSchema).min(1),
});

export type SafetyTarget = z.infer<typeof SafetyTargetSchema>;

export const SafetyPanelFileSchema = z.object({
    schema_version: z.literal(1),
    panel_version: z.string().regex(/^\d+\.\d+\.\d+$/, "semver"),
    curated_at: IsoDateSchema,
    targets: z.array(SafetyTargetSchema),
});

export type SafetyPanelFile = z.infer<typeof SafetyPanelFileSchema>;
