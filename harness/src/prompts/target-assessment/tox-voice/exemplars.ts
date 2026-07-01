export type SectionType = "liability-bullets" | "target-organ-liabilities" | "translational-commentary" | "executive-recommendation";

/**
 * Annotated few-shot exemplars per section type. Each is an inlined sample
 * of acceptable tox voice. Implementations may extend this list during
 * editorial review with customer; the probe and prompts both read the
 * exported array, so additions take effect with no other code changes.
 */
export const toxVoiceExemplars: Record<SectionType, readonly string[]> = {
    "liability-bullets": [
        "Hepatobiliary liability is consistent with on-target pharmacology in the bile-acid receptor class; transaminase elevations at supratherapeutic exposure have been reported across the precedent class (FAERS n=312, Drugs@FDA NDA 022501 §6.1).",
        "Renal liability cannot be excluded on present data; expression in proximal tubule is high (HPA TPM 142) and IMPC homozygotes show albuminuria (p=8.4e-5). Human relevance is uncertain pending dedicated repeat-dose toxicology.",
    ],
    "target-organ-liabilities": [
        "Cardiac. Available evidence is consistent with QT-interval prolongation as a class effect (FAERS PT QT-prolonged n=87 across precedent class). Human relevance is supported by hERG inhibition data on three precedent compounds. Mitigation: ICH E14-aligned thorough QT study at first-in-human or matched concentration-QT modelling.",
        "Hepatobiliary. The data suggest dose-dependent transaminase elevation; FAERS reports of clinical hepatic injury (n=42) cluster at exposures >2-fold the recommended human dose. The translational chain from rodent repeat-dose findings to human signal is consistent.",
    ],
    "translational-commentary": [
        "IMPC homozygous knockout mice show postnatal lethality with cardiac structural abnormalities (MP:0001297, MP:0010880). Heterozygous viability with cardiac function deficit suggests dose-dependent on-target liability; translatability to humans is supported by conserved expression in fetal myocardium (Bgee, n=14).",
        "Expression is high in haematologic lineages (HPA TPM, lymphoid TPM=78). The data are consistent with on-target myelosuppression observed in two precedent compounds in the same class; human relevance is established for the class.",
    ],
    "executive-recommendation": [
        "Disposition: conditional. The available evidence supports tractability for small-molecule modulation; the principal liability is on-target hepatobiliary toxicity, mitigable by exposure margin design and ICH S7A-aligned safety pharmacology. Confidence is moderate; key gaps are an absent first-in-human safety dataset and uncertain reproductive toxicology.",
        "Disposition: de-prioritize. Three precedent compounds in this class were withdrawn for cardiac liability post-approval (Drugs@FDA NDA 020841 §6.2; FAERS n=412); human relevance is established. The therapeutic window does not support advancement absent a structural mitigation strategy.",
    ],
};
