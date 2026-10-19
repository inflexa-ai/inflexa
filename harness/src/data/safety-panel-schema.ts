import { z } from "zod";

import { OrganSystemSchema } from "../contracts/organ-system.js";
import { SeveritySchema } from "../contracts/severity.js";
import { isDigits } from "../lib/text.js";

function isUpperAlphanumeric(value: string): boolean {
    if (value.length === 0) return false;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        const upper = code >= 65 && code <= 90;
        const digit = code >= 48 && code <= 57;
        if (!upper && !digit) return false;
    }
    return true;
}

/** A ChEMBL target id: `CHEMBL` plus digits, for example `CHEMBL5619`. */
export function isChemblId(value: string): boolean {
    return value.startsWith("CHEMBL") && isDigits(value.slice(6));
}

/**
 * UniProt 6-char accession: letter (any A-Z, covering A-N, O, P, Q, R-Z sub-families),
 * followed by a digit, three alphanumerics, and a final digit.
 */
export function isUniprotAccession(value: string): boolean {
    if (value.length !== 6) return false;
    const first = value.charCodeAt(0);
    if (first < 65 || first > 90) return false;
    if (value[1] < "0" || value[1] > "9") return false;
    if (!isUpperAlphanumeric(value.slice(2, 5))) return false;
    const last = value.charCodeAt(5);
    return last >= 48 && last <= 57;
}

/** An Ensembl gene id: `ENSG` plus 11 digits. */
export function isEnsgId(value: string): boolean {
    return value.length === 15 && value.startsWith("ENSG") && isDigits(value.slice(4));
}

/** Three dot-separated digit runs: `\d+.\d+.\d+`. It reads the segments only, with no range validation. */
export function isSemver(value: string): boolean {
    const segments = value.split(".");
    return segments.length === 3 && segments.every((segment) => isDigits(segment));
}

function isHgncStyleSymbol(value: string): boolean {
    const segments = value.split("-");
    const first = segments[0].charCodeAt(0);
    if (first < 65 || first > 90) return false;
    return segments.every((segment) => segment.length > 0 && isUpperAlphanumeric(segment));
}

function isPmidOrDoi(value: string): boolean {
    if (value.startsWith("PMID:")) return isDigits(value.slice(5));
    return value.startsWith("DOI:") && value.length > 4;
}

const ChemblIdSchema = z.string().refine(isChemblId, "must match CHEMBL\\d+");
const GeneSymbolSchema = z
    .string()
    .min(1)
    .max(20)
    .refine(isHgncStyleSymbol, "must be HGNC-style uppercase");
const UniprotSchema = z.string().refine(isUniprotAccession, "must be a 6-char UniProt accession");
const EnsemblGeneSchema = z.string().refine(isEnsgId, "must match ENSG\\d{11}");
const ReferenceSchema = z.string().refine(isPmidOrDoi, "must be PMID:<digits> or DOI:<doi>");
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
    panel_version: z.string().refine(isSemver, "semver"),
    curated_at: IsoDateSchema,
    targets: z.array(SafetyTargetSchema),
});
