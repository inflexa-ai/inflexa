type IntendedPair = { modulator: string; coTarget: string; reason: string };

/**
 * Hand-curated catalogue of multi-target peptide agonists. Conservative
 * by design — only well-documented dual/triple agonists where the
 * additional receptor IS the marketed mechanism. Ambiguous cases stay
 * in the off-target panel.
 *
 * Source: ChEMBL triage_rationale strings + class-precedent literature.
 * Extend as new dual/triple agonists appear in chembl-modulators output.
 */
const INTENDED_PAIRS: IntendedPair[] = [
    { modulator: "CHEMBL4297839", coTarget: "CHEMBL4383", reason: "tirzepatide is a dual GLP-1R/GIPR agonist" },
    { modulator: "CHEMBL4297630", coTarget: "CHEMBL1985", reason: "cotadutide is a dual GLP-1R/GCGR agonist" },
    { modulator: "CHEMBL5095485", coTarget: "CHEMBL4383", reason: "retatrutide is a triple GLP-1R/GIPR/GCGR agonist" },
    { modulator: "CHEMBL5095485", coTarget: "CHEMBL1985", reason: "retatrutide is a triple GLP-1R/GIPR/GCGR agonist" },
    { modulator: "CHEMBL5314776", coTarget: "CHEMBL1985", reason: "survodutide is a dual GLP-1R/GCGR agonist" },
    { modulator: "CHEMBL4297576", coTarget: "CHEMBL1985", reason: "efinopegdutide is a dual GLP-1R/GCGR agonist" },
    { modulator: "CHEMBL3990012", coTarget: "CHEMBL1985", reason: "pegapamodutide is a dual GLP-1R/GCGR agonist" },
];

export function isIntendedCoTarget(modulatorChemblId: string, offTargetChemblId: string): { intended: boolean; reason?: string } {
    const hit = INTENDED_PAIRS.find((p) => p.modulator === modulatorChemblId && p.coTarget === offTargetChemblId);
    if (hit) return { intended: true, reason: hit.reason };
    return { intended: false };
}
