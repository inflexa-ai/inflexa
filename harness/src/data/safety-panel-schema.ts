import { z } from "zod";

import { OrganSystemSchema } from "../contracts/organ-system.js";
import { SeveritySchema } from "../contracts/severity.js";

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the fixed CHEMBL<n> shape is the identifier that the ChEMBL registry issues.
export const CHEMBL_RE = /^CHEMBL\d+$/;
// UniProt 6-char accession: letter (any A-Z, covering A-N, O, P, Q, R-Z sub-families),
// followed by a digit, three alphanumerics, and a final digit.
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the fixed six-character accession shape is what UniProt issues.
export const UNIPROT_RE = /^[A-Z][0-9][A-Z0-9]{3}[0-9]$/;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- an HGNC symbol is uppercase alphanumeric segments joined by hyphens; the shape is the naming rule.
const HGNC_SYMBOL_RE = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$/;
const ChemblIdSchema = z.string().regex(CHEMBL_RE, "must match CHEMBL\\d+");
const GeneSymbolSchema = z
    .string()
    .min(1)
    .max(20)
    .regex(HGNC_SYMBOL_RE, "must be HGNC-style uppercase");
const UniprotSchema = z.string().regex(UNIPROT_RE, "must be a 6-char UniProt accession");
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- an Ensembl gene id is ENSG plus 11 digits, the fixed Ensembl shape.
const ENSEMBL_GENE_RE = /^ENSG\d{11}$/;
const EnsemblGeneSchema = z.string().regex(ENSEMBL_GENE_RE, "must match ENSG\\d{11}");
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- a reference is one of the two prefixed provenance forms; the alternation is the rule.
const REFERENCE_RE = /^(PMID:\d+|DOI:.+)$/;
const ReferenceSchema = z.string().regex(REFERENCE_RE, "must be PMID:<digits> or DOI:<doi>");
const IsoDateSchema = z.iso.date();

export const SafetyTargetSchema = z.object({
    chembl_id: ChemblIdSchema,
    gene_symbol: GeneSymbolSchema,
    uniprot: UniprotSchema,
    ensembl_gene_id: EnsemblGeneSchema.optional(),
    name: z.string().min(1).max(120),
    organ_system: OrganSystemSchema,
    clinical_consequence: z.string().min(1).max(200),
    severity: SeveritySchema,
    references: z.array(ReferenceSchema).min(1),
});

export type SafetyTarget = z.infer<typeof SafetyTargetSchema>;

export const SafetyPanelFileSchema = z.object({
    schema_version: z.literal(1),
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- a dotted three-part version is the file format's own version rule.
    panel_version: z.string().regex(/^\d+\.\d+\.\d+$/, "semver"),
    curated_at: IsoDateSchema,
    targets: z.array(SafetyTargetSchema),
});
