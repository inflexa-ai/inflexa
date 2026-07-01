/**
 * TPM threshold for "high expression" classification, aligned with the
 * Human Protein Atlas tissue-expression categorisation. Tissues with
 * TPM >= this threshold count toward
 * liability_summary.expression_breadth.high_expression_tissue_count
 * and inform organ-rollup signal scoring.
 */
export const HIGH_EXPRESSION_TPM_THRESHOLD = 50;

/**
 * Off-tissue floor for CNS regions. Brain subregions (hypothalamus excepted)
 * carry biologically meaningful CALCR/peptide-GPCR expression at single-digit
 * nTPM; the default 100 floor produced organ_claim_without_probe_pass audit
 * failures for CNS bullets that the recommendation makes.
 */
export const CNS_REGION_TPM_FLOOR = 5;

/**
 * Off-tissue floor for musculoskeletal tissues. Skeletal muscle and bone
 * surfaces routinely show 20-80 nTPM for GPCRs whose ligands affect
 * mineral and muscle metabolism.
 */
export const MUSCULOSKELETAL_TPM_FLOOR = 20;
