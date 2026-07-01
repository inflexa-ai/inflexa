# MSstats / MSstatsTMT via rpy2

R packages for statistical analysis of quantitative mass spectrometry proteomics. MSstats handles label-free and label-based (DDA, DIA, SRM) experiments. MSstatsTMT handles isobaric labeling (TMT, iTRAQ).

## rpy2 Setup

```python
import pandas as pd
import numpy as np
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri
from rpy2.robjects.packages import importr
from rpy2.robjects.conversion import localconverter

msstats = importr("MSstats")
base = importr("base")

converter = ro.default_converter + pandas2ri.converter
```

## Input Format (MSstats)

MSstats requires a **long-format** data.frame with these exact column names:

| Column | Type | Description |
|--------|------|-------------|
| `ProteinName` | character | Protein identifier |
| `PeptideSequence` | character | Peptide sequence |
| `PrecursorCharge` | integer | Precursor charge state |
| `FragmentIon` | character | Fragment ion (NA for DDA) |
| `ProductCharge` | integer | Product charge (NA for DDA) |
| `IsotopeLabelType` | character | `"L"` (light) or `"H"` (heavy) |
| `Condition` | character | Biological condition/group |
| `BioReplicate` | character | Biological replicate ID |
| `Run` | character | MS run identifier |
| `Intensity` | numeric | Raw intensity (not log-transformed) |

```python
# Build MSstats input from a wide protein intensity table
records = []
for _, row in protein_table.iterrows():
    for sample in sample_columns:
        condition, biorep = sample_to_condition[sample], sample_to_biorep[sample]
        records.append({
            "ProteinName": row["Protein.IDs"],
            "PeptideSequence": row.get("Peptide.Sequence", ""),
            "PrecursorCharge": row.get("Charge", 2),
            "FragmentIon": pd.NA,
            "ProductCharge": pd.NA,
            "IsotopeLabelType": "L",
            "Condition": condition,
            "BioReplicate": biorep,
            "Run": sample,
            "Intensity": row[sample],
        })
input_df = pd.DataFrame(records)
```

**Gotcha**: `Intensity` must be raw (not log-transformed). MSstats handles transformation internally. Zero intensities should be `NA`, not `0`.

### Converter Functions

MSstats provides converter functions for common search engine outputs:

```python
# From MaxQuant evidence.txt
raw = msstats.MaxQtoMSstatsFormat(evidence, annotation, proteinGroups)

# From FragPipe (Philosopher)
raw = msstats.PhilosophertoMSstatsFormat(input_data, annotation)

# From DIA-NN
raw = msstats.DIANNtoMSstatsFormat(input_data, annotation)

# From Spectronaut
raw = msstats.SpectronauttoMSstatsFormat(input_data, annotation)
```

## dataProcess -- Preprocessing

`dataProcess(raw, logTrans, normalization, summaryMethod, censoredInt, MBimpute, featureSubset)` performs log-transformation, normalization, feature selection, and protein-level summarization.

```python
with localconverter(converter):
    raw_r = ro.conversion.get_conversion().py2rpy(input_df)

processed = msstats.dataProcess(
    raw_r,
    logTrans=2,                    # log2 transform (2=log2, 10=log10)
    normalization="equalizeMedians",  # "equalizeMedians"|"quantile"|"globalStandards"|False
    summaryMethod="TMP",           # "TMP" (Tukey Median Polish) | "linear"
    censoredInt="NA",              # "NA"|"0"|ro.NULL -- how missing values are encoded
    MBimpute=True,                 # Model-Based imputation (accelerated failure model)
    featureSubset="all",           # "all"|"top3"|"topN"|"highQuality"
    # n_top_feature=3,             # if featureSubset="topN"
)
```

**Key parameters**:

| Parameter | Default | Options | Notes |
|-----------|---------|---------|-------|
| `logTrans` | `2` | `2`, `10` | Base for log transform |
| `normalization` | `"equalizeMedians"` | `"equalizeMedians"`, `"quantile"`, `"globalStandards"`, `FALSE` | `FALSE` skips normalization |
| `summaryMethod` | `"TMP"` | `"TMP"`, `"linear"` | TMP = Tukey's Median Polish |
| `censoredInt` | `"NA"` | `"NA"`, `"0"`, `NULL` | How censored values are coded |
| `MBimpute` | `TRUE` | `TRUE`, `FALSE` | Accelerated failure model imputation |
| `featureSubset` | `"all"` | `"all"`, `"top3"`, `"topN"`, `"highQuality"` | Feature selection strategy |

**Gotcha**: `MBimpute=TRUE` only works with `summaryMethod="TMP"` and `censoredInt` set to `"NA"` or `"0"`.

**Returns**: A list with `$FeatureLevelData` (feature-level processed data) and `$ProteinLevelData` (run-level summarized abundances).

```python
# Access processed results
feature_data = processed.rx2("FeatureLevelData")
protein_data = processed.rx2("ProteinLevelData")

with localconverter(converter):
    protein_df = ro.conversion.get_conversion().rpy2py(protein_data)
```

## groupComparison -- Differential Analysis

`groupComparison(contrast.matrix, data)` fits linear mixed-effects models and tests specified contrasts.

```python
# Build contrast matrix: each row is a comparison
# Column names must match condition names exactly
conditions = ["Control", "Treatment1", "Treatment2"]

# Treatment1 vs Control
contrast_matrix = ro.r("""
    matrix(c(-1, 1, 0,
             -1, 0, 1,
              0,-1, 1),
           nrow=3, byrow=TRUE,
           dimnames=list(
               c("Treatment1-Control", "Treatment2-Control", "Treatment2-Treatment1"),
               c("Control", "Treatment1", "Treatment2")
           ))
""")

comparison = msstats.groupComparison(
    contrast_matrix=contrast_matrix,
    data=processed,
)
```

**Returns**: A list with `$ComparisonResult` containing:
- `Protein`: protein identifier
- `Label`: contrast name
- `log2FC`: log2 fold change
- `SE`: standard error
- `Tvalue`: T statistic
- `DF`: degrees of freedom
- `pvalue`: raw p-value
- `adj.pvalue`: BH-adjusted p-value
- `issue`: warning flags (e.g., single feature, missing data)

```python
with localconverter(converter):
    comp_result = ro.conversion.get_conversion().rpy2py(
        comparison.rx2("ComparisonResult")
    )
# Filter significant proteins
sig = comp_result[comp_result["adj.pvalue"] < 0.05]
```

## quantification -- Protein Quantification

```python
# Sample-level quantification
sample_quant = msstats.quantification(processed, type="Sample")

# Group-level quantification (condition means)
group_quant = msstats.quantification(processed, type="Group")

with localconverter(converter):
    quant_df = ro.conversion.get_conversion().rpy2py(sample_quant)
```

## MSstatsTMT -- Isobaric Labeling

For TMT/iTRAQ experiments, use the MSstatsTMT package.

```python
msstats_tmt = importr("MSstatsTMT")
```

### TMT Input Format

| Column | Type | Description |
|--------|------|-------------|
| `ProteinName` | character | Protein identifier |
| `PeptideSequence` | character | Peptide sequence |
| `Charge` | integer | Charge state |
| `PSM` | character | PSM identifier |
| `Mixture` | character | TMT plex/mixture |
| `TechRepMixture` | integer | Technical replicate of mixture |
| `Run` | character | MS run ID |
| `Channel` | character | TMT channel (e.g., `"126"`, `"127N"`) |
| `Condition` | character | Biological condition |
| `BioReplicate` | character | Biological replicate |
| `Intensity` | numeric | Raw intensity |

### TMT Workflow

```python
with localconverter(converter):
    tmt_input_r = ro.conversion.get_conversion().py2rpy(tmt_input_df)

# Protein-level summarization
summarized = msstats_tmt.proteinSummarization(
    tmt_input_r,
    method="msstats",              # "msstats" (TMP) | "MedianPolish" | "LogSum"
    global_norm=True,              # global median normalization across runs
    reference_norm=True,           # normalize to reference channel
    MBimpute=True,
)

# Differential analysis
tmt_contrast = ro.r("""
    matrix(c(-1, 1, 0), nrow=1, byrow=TRUE,
           dimnames=list("Treatment-Control", c("Control","Treatment","Reference")))
""")

tmt_comparison = msstats_tmt.groupComparisonTMT(
    data=summarized,
    contrast_matrix=tmt_contrast,
    moderated=True,                # empirical Bayes moderation (recommended)
)

with localconverter(converter):
    tmt_results = ro.conversion.get_conversion().rpy2py(
        tmt_comparison.rx2("ComparisonResult")
    )
```

### TMT Converter Functions

```python
# From Proteome Discoverer
raw = msstats_tmt.PDtoMSstatsTMTFormat(input_data, annotation)

# From MaxQuant
raw = msstats_tmt.MaxQtoMSstatsTMTFormat(evidence, proteinGroups, annotation)

# From SpectroMine
raw = msstats_tmt.SpectroMinetoMSstatsTMTFormat(input_data, annotation)

# From OpenMS
raw = msstats_tmt.OpenMStoMSstatsTMTFormat(input_data, annotation)
```

## Visualization

```python
# Volcano plot
msstats.groupComparisonPlots(
    data=comparison.rx2("ComparisonResult"),
    type="VolcanoPlot",
    sig=0.05,                      # significance cutoff
    FCcutoff=1.0,                  # log2FC cutoff
    address="output/volcano_",     # file prefix
)

# Comparison plot (per-protein across contrasts)
msstats.groupComparisonPlots(
    data=comparison.rx2("ComparisonResult"),
    type="ComparisonPlot",
    address="output/comparison_",
)

# QC plot from processed data
msstats.dataProcessPlots(processed, type="QCPlot", address="output/qc_")
msstats.dataProcessPlots(processed, type="ProfilePlot", address="output/profile_")
```

## Version Notes

- MSstats >= 4.10 (Bioconductor 3.20+): uses `data.table` internally for performance.
- MSstatsTMT >= 2.10: supports `moderated=TRUE` for empirical Bayes in `groupComparisonTMT`.
- Converter functions vary by version -- check available converters with `dir(msstats)`.
- `groupComparison` contrast matrix column names must match `Condition` values exactly.
