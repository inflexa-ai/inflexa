# /// script
# dependencies = ["pandas"]
# [tool.uv]
# exclude-newer = "2026-09-25T00:00:00Z"
# ///
"""Build derived/cancer_mut/sankey_flows.csv: TCGA LAML patients flowing from
FAB subtype, to FLT3 mutation status, to vital status.

Usage: uv run sankey_cancer_mut.py <gallery-data work dir>

Reads raw/cancer_mut/tcga_laml.maf.gz (FLT3 status) and
raw/cancer_mut/tcga_laml_annot.tsv (FAB_classification, Overall_Survival_Status;
maftools' own clinical annotation for this MAF). scripts/gallery-data.sh
downloads both to raw/cancer_mut/.

The annotation file has 200 patients; the example MAF covers only 193 of
them (the other 7 have no mutation calls at all in this file, so FLT3 status
is undeterminable for them). The cohort here is the 193 patients present in
both files. FLT3 status is "FLT3 mutated" for a patient with >=1 MAF row for
Hugo_Symbol == FLT3 (any Variant_Classification; none are Silent in this
MAF), else "FLT3 wild type". Overall_Survival_Status is read as the standard
TCGA/cBioPortal OS_STATUS convention (1 = deceased, 0 = alive): the file
itself does not spell this out, but the observed 127-deceased/66-alive split
in this 193-patient subset is consistent with published survival for this
cohort (Ley et al. NEJM 2013), and inconsistent with the reverse reading.
One patient in the cohort has no recorded FAB_classification; it gets its
own "FAB unknown" stage-1 node rather than being dropped.

Deterministic: no random sampling.
"""

import gzip
import pathlib
import sys

import pandas as pd

BASE = pathlib.Path(sys.argv[1])
RAW = BASE / "raw" / "cancer_mut"
DERIVED = BASE / "derived" / "cancer_mut"
DERIVED.mkdir(parents=True, exist_ok=True)

MAF_PATH = RAW / "tcga_laml.maf.gz"
ANNOT_PATH = RAW / "tcga_laml_annot.tsv"

FAB_ORDER = ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7"]


def main() -> None:
    with gzip.open(MAF_PATH, "rt") as fh:
        maf = pd.read_csv(fh, sep="\t", dtype=str)
    annot = pd.read_csv(ANNOT_PATH, sep="\t", dtype=str)

    maf_samples = set(maf["Tumor_Sample_Barcode"].unique())
    annot_only = set(annot["Tumor_Sample_Barcode"]) - maf_samples
    cohort = annot[annot["Tumor_Sample_Barcode"].isin(maf_samples)].copy()

    flt3_mutated_samples = set(
        maf.loc[maf["Hugo_Symbol"] == "FLT3", "Tumor_Sample_Barcode"].unique()
    )
    cohort["flt3_status"] = cohort["Tumor_Sample_Barcode"].apply(
        lambda s: "FLT3 mutated" if s in flt3_mutated_samples else "FLT3 wild type"
    )
    cohort["vital_status"] = cohort["Overall_Survival_Status"].map({"1": "Deceased", "0": "Alive"})
    if cohort["vital_status"].isna().any():
        bad = cohort.loc[cohort["vital_status"].isna(), "Overall_Survival_Status"].unique()
        raise RuntimeError(f"Overall_Survival_Status has values outside {{0,1}}: {bad}")

    # A patient with no recorded FAB subtype still gets a Sankey source node,
    # so every one of the 193 cohort patients appears in stage 1.
    cohort["fab"] = cohort["FAB_classification"].fillna("FAB unknown")
    fab_present = [f for f in FAB_ORDER if f in cohort["fab"].unique()]
    fab_other = sorted(set(cohort["fab"].unique()) - set(fab_present))
    fab_order_all = fab_present + fab_other  # a non-M0..M7 value (FAB unknown) sorts after M7

    stage1_to_2 = cohort.groupby(["fab", "flt3_status"]).size().reset_index(name="value")
    stage1_to_2 = stage1_to_2.rename(columns={"fab": "source", "flt3_status": "target"})
    stage1_to_2["_stage"] = 0
    stage1_to_2["_order"] = stage1_to_2["source"].map({f: i for i, f in enumerate(fab_order_all)})

    stage2_to_3 = cohort.groupby(["flt3_status", "vital_status"]).size().reset_index(name="value")
    stage2_to_3 = stage2_to_3.rename(columns={"flt3_status": "source", "vital_status": "target"})
    stage2_to_3["_stage"] = 1
    stage2_to_3["_order"] = stage2_to_3["source"].map({"FLT3 mutated": 0, "FLT3 wild type": 1})

    flows = pd.concat([stage1_to_2, stage2_to_3], ignore_index=True)
    flows = (
        flows.sort_values(["_stage", "_order", "source", "target"])
        .drop(columns=["_stage", "_order"])
        .reset_index(drop=True)
    )
    flows = flows[["source", "target", "value"]]

    out_path = DERIVED / "sankey_flows.csv"
    flows.to_csv(out_path, index=False)

    print(f"annotation cohort: {len(annot)} patients; MAF cohort: {len(maf_samples)} patients")
    print(f"annotation-only patients excluded (no MAF row): {len(annot_only)}")
    print(f"sankey cohort: {len(cohort)} patients")
    print(f"FAB_classification values present: {fab_order_all}")
    print(f"FLT3 mutated: {(cohort['flt3_status'] == 'FLT3 mutated').sum()}, wild type: {(cohort['flt3_status'] == 'FLT3 wild type').sum()}")
    print(f"Deceased: {(cohort['vital_status'] == 'Deceased').sum()}, Alive: {(cohort['vital_status'] == 'Alive').sum()}")
    print(f"sankey_flows.csv: {len(flows)} rows, {out_path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
