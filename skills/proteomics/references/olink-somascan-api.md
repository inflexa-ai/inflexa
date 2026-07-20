# Olink and SomaScan -- Affinity-Based Proteomics Preprocessing

Preprocessing patterns for high-throughput affinity proteomics platforms. Olink uses Proximity Extension Assay (PEA) reporting Normalized Protein eXpression (NPX) values. SomaScan uses modified aptamers (SOMAmer) reporting Relative Fluorescence Units (RFU).

## Olink Preprocessing

### NPX Data Structure

Olink exports data in long format (one row per sample-assay pair) or wide format (samples as rows, proteins as columns). NPX values are already log2-scaled and normalized per plate.

```python
import pandas as pd
import numpy as np

# Typical Olink export (long format)
# Columns: SampleID, OlinkID, UniProt, Assay, Panel, NPX, LOD, MissingFreq, QC_Warning
olink_long = pd.read_csv("olink_npx_data.csv")

# Pivot to wide format: samples x proteins
olink_wide = olink_long.pivot_table(
    index="SampleID",
    columns="OlinkID",       # use OlinkID (stable) not Assay name
    values="NPX",
    aggfunc="first",
)
```

### LOD (Limit of Detection) Handling

Values below LOD are detected but unreliable. Common strategies:

```python
# Strategy 1: Flag sub-LOD values as NaN
lod_map = olink_long.groupby("OlinkID")["LOD"].first()
for olink_id in olink_wide.columns:
    lod = lod_map.get(olink_id, -np.inf)
    olink_wide.loc[olink_wide[olink_id] < lod, olink_id] = np.nan

# Strategy 2: Replace sub-LOD with LOD value (censored)
for olink_id in olink_wide.columns:
    lod = lod_map.get(olink_id, -np.inf)
    olink_wide[olink_id] = olink_wide[olink_id].clip(lower=lod)

# Strategy 3: Filter assays with >X% sub-LOD
pct_below = (olink_long.groupby("OlinkID")
             .apply(lambda g: (g["NPX"] < g["LOD"]).mean()))
keep_assays = pct_below[pct_below < 0.25].index  # keep if <25% below LOD
olink_wide = olink_wide[keep_assays]
```

**Gotcha**: NPX values are relative, not absolute concentrations. Comparisons are valid within an assay across samples, not between assays.

### Bridge Normalization (Multi-Batch)

When combining Olink data across batches/plates, use bridge samples (same samples run on both batches) to correct batch effects.

```python
# Bridge normalization: adjust batch 2 to match batch 1 using shared bridge samples
def bridge_normalize(df_old, df_new, bridge_sample_ids):
    """Adjust df_new NPX values to align with df_old using bridge samples."""
    bridge_old = df_old.loc[df_old.index.isin(bridge_sample_ids)]
    bridge_new = df_new.loc[df_new.index.isin(bridge_sample_ids)]

    # Per-assay median shift
    median_old = bridge_old.median(axis=0)
    median_new = bridge_new.median(axis=0)
    adjustment = median_old - median_new

    return df_new + adjustment  # shift all samples in new batch

normalized_batch2 = bridge_normalize(batch1_wide, batch2_wide, bridge_ids)
combined = pd.concat([batch1_wide, normalized_batch2])
```

For production use, prefer the OlinkAnalyze R package which implements robust bridge normalization with outlier handling:

```python
import rpy2.robjects as ro
from rpy2.robjects.packages import importr
from rpy2.robjects import pandas2ri
from rpy2.robjects.conversion import localconverter

olink = importr("OlinkAnalyze")
converter = ro.default_converter + pandas2ri.converter

with localconverter(converter):
    combined_r = ro.conversion.get_conversion().py2rpy(olink_long_combined)
    bridged = olink.olink_normalization_bridge(
        df1=batch1_r,        # reference batch (long format)
        df2=batch2_r,        # batch to adjust
        overlapping_samples_df1=bridge_r,  # bridge samples in batch 1
    )
    bridged_df = ro.conversion.get_conversion().rpy2py(bridged)
```

### QC Filtering

```python
# Remove samples with QC warnings
qc_pass = olink_long[olink_long["QC_Warning"] != "Warning"]

# Remove assays with high variability in controls.
# NPX is already log2-scale, so std/mean is NOT a CV — the mean can sit near or
# below zero and the ratio becomes meaningless or sign-flipped. Either use the
# SD of NPX directly (a log2-scale dispersion measure), or linearize first.
ctrl = olink_long[olink_long["SampleID"].str.contains("CTRL")]

sd_by_assay = ctrl.groupby("OlinkID")["NPX"].std()
reliable_assays = sd_by_assay[sd_by_assay < 0.2].index   # < 0.2 log2 units

# Equivalent on the linear scale, if you want a true CV:
# cv_by_assay = ctrl.groupby("OlinkID")["NPX"].agg(
#     lambda x: (2 ** x).std() / (2 ** x).mean()
# )
```

### Create AnnData from Olink

```python
import anndata as ad

obs = pd.DataFrame(index=olink_wide.index)  # sample metadata
obs["condition"] = metadata.set_index("SampleID").loc[obs.index, "Condition"]

var = pd.DataFrame(index=olink_wide.columns)  # protein metadata
assay_info = olink_long.drop_duplicates("OlinkID").set_index("OlinkID")
var["UniProt"] = assay_info.loc[var.index, "UniProt"]
var["Assay"] = assay_info.loc[var.index, "Assay"]
var["Panel"] = assay_info.loc[var.index, "Panel"]

adata = ad.AnnData(
    X=olink_wide.values.astype(np.float32),  # NPX values (already log2-scale)
    obs=obs,
    var=var,
)
adata.layers["raw_npx"] = adata.X.copy()
```

---

## SomaScan Preprocessing

### ADAT File Format

SomaScan delivers data as `.adat` files (tab-delimited with headers). The SomaDataIO R package or manual parsing provides access to RFU values.

```python
# Parse ADAT file manually (Python)
def read_adat(path):
    """Read SomaScan ADAT file into a DataFrame."""
    with open(path) as f:
        lines = f.readlines()

    # Find header row (starts with tab-separated column names after metadata block)
    header_idx = None
    for i, line in enumerate(lines):
        if line.startswith("\t") or "PlateId" in line:
            header_idx = i
            break

    df = pd.read_csv(path, sep="\t", skiprows=header_idx)
    return df

# Using SomaDataIO via rpy2 (recommended)
base = importr("base")
somadata = importr("SomaDataIO")
with localconverter(converter):
    adat = somadata.read_adat("sample_data.adat")
    adat_df = ro.conversion.get_conversion().rpy2py(base.as_data_frame(adat))
```

### RFU Values and Aptamer Metadata

SomaScan columns are aptamer IDs (e.g., `seq.10000.28`). Each maps to a protein target.

```python
# Separate sample metadata from RFU measurement columns
seq_cols = [c for c in adat_df.columns if c.startswith("seq.")]
meta_cols = [c for c in adat_df.columns if not c.startswith("seq.")]

rfu_matrix = adat_df[seq_cols].astype(np.float64)
sample_meta = adat_df[meta_cols]

# Aptamer annotations (from SomaScan menu or col.meta in ADAT)
# Typical fields: SeqId, Target, TargetFullName, UniProt, EntrezGeneSymbol, Type, Dilution
```

### ANML Normalization

SomaScan applies Adaptive Normalization by Maximum Likelihood (ANML) during standard processing. If working with non-ANML data:

```python
# Log-transform RFU values
log_rfu = np.log2(rfu_matrix)

# Median normalization (simple alternative when ANML not available)
sample_medians = log_rfu.median(axis=1)
global_median = sample_medians.median()
norm_rfu = log_rfu.subtract(sample_medians, axis=0) + global_median

# Dilution-aware normalization: SomaScan runs 3 dilution groups (20%, 5%, 0.5%)
# Each dilution group should be normalized separately
for dilution in ["20%", "5%", "0.5%"]:
    dil_cols = aptamer_meta[aptamer_meta["Dilution"] == dilution]["SeqId"].tolist()
    dil_data = log_rfu[dil_cols]
    dil_medians = dil_data.median(axis=1)
    dil_global = dil_medians.median()
    norm_rfu[dil_cols] = dil_data.subtract(dil_medians, axis=0) + dil_global
```

**Gotcha**: Always normalize within dilution groups first, then combine. Cross-dilution normalization can introduce artifacts.

### QC and Filtering

```python
# Flag calibrator and buffer samples
sample_mask = sample_meta["SampleType"] == "Sample"  # exclude QC, Buffer, Calibrator
rfu_samples = rfu_matrix[sample_mask]

# Filter low-signal aptamers
median_rfu = rfu_samples.median(axis=0)
keep_aptamers = median_rfu[median_rfu > 200].index  # minimum RFU threshold

# Filter samples with unusual total signal
total_signal = rfu_samples.sum(axis=1)
z_scores = (total_signal - total_signal.mean()) / total_signal.std()
keep_samples = z_scores[z_scores.abs() < 3].index
```

### Create AnnData from SomaScan

```python
import anndata as ad

rfu_clean = norm_rfu.loc[keep_samples, keep_aptamers]

obs = sample_meta.loc[keep_samples].copy()
obs.index = obs.index.astype(str)

var = pd.DataFrame(index=keep_aptamers)
var["Target"] = aptamer_meta.set_index("SeqId").loc[var.index, "Target"]
var["UniProt"] = aptamer_meta.set_index("SeqId").loc[var.index, "UniProt"]
var["EntrezGeneSymbol"] = aptamer_meta.set_index("SeqId").loc[var.index, "EntrezGeneSymbol"]
var["Dilution"] = aptamer_meta.set_index("SeqId").loc[var.index, "Dilution"]

adata = ad.AnnData(
    X=rfu_clean.values.astype(np.float32),  # log2(RFU), normalized
    obs=obs,
    var=var,
)
adata.layers["log2_rfu"] = adata.X.copy()
adata.uns["normalization"] = "log2_median_per_dilution"
```

## Platform Comparison Notes

| Aspect | Olink | SomaScan |
|--------|-------|----------|
| Unit | NPX (log2-scale) | RFU (linear scale, log-transform recommended) |
| Normalization | Per-plate, inter-plate bridging | ANML, dilution-group median |
| Missing data | Sub-LOD flagging | Rare (signal always measured) |
| Proteins | ~3000 (Explore 3072) | ~7000+ (SomaScan v4.1) |
| Key R package | OlinkAnalyze | SomaDataIO |
| Dynamic range | ~4 logs NPX | ~4-5 logs RFU |

**Gotcha**: Olink NPX and SomaScan RFU are NOT directly comparable. Cross-platform analyses require protein-level z-scoring or rank-based normalization after individual platform preprocessing.
