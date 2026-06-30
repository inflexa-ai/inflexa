export function computeSelectivity(input: {
    primary_pchembl: number | null;
    off_target_pchembl: number | null;
    primary_source?: "chembl_target_drug_indication" | "literature_curated";
}):
    | {
          vs_primary_potency: {
              primary_pchembl_used: number;
              primary_source: "chembl_target_drug_indication" | "literature_curated";
              fold: number;
              log_units: number;
          };
      }
    | { selectivity_unknown: true; reason: string } {
    if (input.primary_pchembl == null) {
        return { selectivity_unknown: true, reason: "no primary pChEMBL available for this modulator in ChEMBL target-drug-indication table" };
    }
    if (input.off_target_pchembl == null) {
        return { selectivity_unknown: true, reason: "no off-target pChEMBL recorded" };
    }
    const logUnits = input.primary_pchembl - input.off_target_pchembl;
    const fold = Math.pow(10, logUnits);
    return {
        vs_primary_potency: {
            primary_pchembl_used: input.primary_pchembl,
            primary_source: input.primary_source ?? "chembl_target_drug_indication",
            fold,
            log_units: logUnits,
        },
    };
}
