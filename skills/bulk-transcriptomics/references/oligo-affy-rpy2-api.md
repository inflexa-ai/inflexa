# oligo/affy via rpy2 API Reference

Microarray preprocessing using oligo (preferred) and affy (legacy) packages via rpy2. Covers reading CEL files, RMA normalization, MAS5 detection calls, and converting results to AnnData.

## rpy2 Setup

```python
import pandas as pd
import numpy as np
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri
from rpy2.robjects.conversion import localconverter
from rpy2.robjects.packages import importr

pandas2ri.activate()

oligo = importr("oligo")
affy = importr("affy")
base = importr("base")
biobase = importr("Biobase")
```

## Conversion Helpers

```python
def r_to_pd(r_obj):
    with localconverter(ro.default_converter + pandas2ri.converter):
        return ro.conversion.rpy2py(r_obj)

def exprs_to_df(eset):
    """Extract expression matrix from ExpressionSet as pandas DataFrame."""
    expr_mat = biobase.exprs(eset)
    df = r_to_pd(base.as_data_frame(expr_mat))
    df.index = list(base.rownames(expr_mat))
    df.columns = list(base.colnames(expr_mat))
    return df

def pdata_to_df(eset):
    """Extract sample metadata (phenoData) from ExpressionSet."""
    pd_r = biobase.pData(eset)
    return r_to_pd(pd_r)
```

## Reading CEL Files with oligo (Preferred)

oligo supports all Affymetrix array types including Gene ST, Exon ST, and HTA arrays. Uses 33% less memory than affy.

```python
import os

# Point this at the directory holding the run's CEL files, discovered from the
# step's own inputs. Never hardcode an absolute path.
cel_dir = os.environ.get("CEL_DIR") or "."

# List all CEL files
cel_files = ro.r(f'list.celfiles("{cel_dir}", full.names=TRUE, listGzipped=TRUE)')

# Read CEL files into a GeneFeatureSet (or ExonFeatureSet, etc.)
raw_data = oligo.read_celfiles(cel_files)

# Check array type
print(ro.r("class")(raw_data))
# [1] "GeneFeatureSet" or "ExpressionFeatureSet" etc.
```

### read.celfiles Signature

```python
raw_data = oligo.read_celfiles(
    filenames,                 # character vector — paths to CEL files
    phenoData=ro.NULL,         # AnnotatedDataFrame | NULL — sample metadata
    verbose=True,              # bool
)
# Returns: GeneFeatureSet, ExonFeatureSet, or ExpressionFeatureSet
# depending on the array platform
```

### Providing Sample Metadata at Read Time

```python
# Create phenoData from a pandas DataFrame
metadata = pd.DataFrame({
    "condition": ["ctrl", "ctrl", "treat", "treat"],
    "batch": ["A", "B", "A", "B"],
}, index=["sample1.CEL", "sample2.CEL", "sample3.CEL", "sample4.CEL"])

metadata_r = ro.DataFrame(metadata)
# Wrap in AnnotatedDataFrame
pheno_data = ro.r('''
    function(df) {
        new("AnnotatedDataFrame", data=df)
    }
''')(metadata_r)

raw_data = oligo.read_celfiles(cel_files, phenoData=pheno_data)
```

## RMA Normalization with oligo

```python
# Standard RMA: background correction + quantile normalization + summarization
eset = oligo.rma(raw_data)

# For Gene/Exon ST arrays: specify summarization target
eset = oligo.rma(raw_data, target="core")
# target options: "probeset" (default for expression arrays),
#                 "core", "extended", "full" (for Gene/Exon ST arrays)

# Extract log2-scale expression matrix
expr_df = exprs_to_df(eset)
# expr_df shape: (n_probesets, n_samples), values are log2-scale
```

## Reading CEL Files with affy (Legacy)

Only supports older 3' IVT Affymetrix arrays (HG-U133, HG-U95, MOE430, RAE230, etc.). Does NOT support Gene ST or Exon ST arrays.

```python
# Read CEL files
raw_data = affy.ReadAffy(celfile_path=cel_dir)
# Or with explicit filenames:
raw_data = affy.ReadAffy(
    filenames=ro.StrVector([
        os.path.join(cel_dir, f) for f in cel_filenames
    ])
)

# RMA normalization
eset = affy.rma(raw_data)
expr_df = exprs_to_df(eset)
```

### affy justrma (Read + RMA in One Step)

```python
# More memory-efficient: reads and normalizes in one pass
eset = affy.justRMA(celfile_path=cel_dir)
expr_df = exprs_to_df(eset)
```

## MAS5 Detection Calls

MAS5 presence/absence calls classify probesets as Present (P), Marginal (M), or Absent (A). Useful for filtering non-expressed genes before DE analysis.

```python
# --- affy package (3' IVT arrays only) ---
raw_data = affy.ReadAffy(celfile_path=cel_dir)
mas5_calls = affy.mas5calls(raw_data)

# Extract call matrix (P/M/A)
calls_mat = biobase.exprs(mas5_calls)
calls_df = r_to_pd(base.as_data_frame(calls_mat))
calls_df.index = list(base.rownames(calls_mat))
calls_df.columns = list(base.colnames(calls_mat))

# Extract detection p-values
ro.r.assign("mas5_calls", mas5_calls)
pvals = ro.r('assayData(mas5_calls)[["se.exprs"]]')
pval_df = r_to_pd(base.as_data_frame(pvals))
pval_df.index = list(base.rownames(pvals))

# Filter: keep genes present in at least N samples
n_samples_required = 2
present_mask = (calls_df == "P").sum(axis=1) >= n_samples_required
filtered_genes = calls_df.index[present_mask].tolist()
```

### MAS5 for Gene ST Arrays (via oligo)

```python
# oligo does not have mas5calls. For Gene/Exon ST arrays, filter by expression level:
expr_df = exprs_to_df(eset)
# Typical filter: remove probesets with median log2 expression < threshold
median_expr = expr_df.median(axis=1)
keep = median_expr[median_expr > 4.0].index  # adjust threshold per dataset
expr_filtered = expr_df.loc[keep]
```

## Converting to AnnData

```python
import anndata as ad

# expr_df: genes as rows, samples as columns (log2-scale from RMA)
# Transpose for AnnData: samples as rows, genes as columns
adata = ad.AnnData(
    X=expr_df.T.values,                    # (n_samples, n_genes) matrix
    obs=pd.DataFrame(index=expr_df.columns),  # sample metadata
    var=pd.DataFrame(index=expr_df.index),    # gene/probeset metadata
)

# Add sample metadata if available
sample_meta = pdata_to_df(eset)
for col in sample_meta.columns:
    adata.obs[col] = sample_meta[col].values

# Add detection calls as a layer (if available)
if calls_df is not None:
    # Encode P=1, M=0.5, A=0 for downstream filtering
    call_numeric = calls_df.replace({"P": 1.0, "M": 0.5, "A": 0.0}).T
    adata.layers["detection_calls"] = call_numeric.values

# Store that this is log2-RMA data (NOT raw counts)
adata.uns["preprocessing"] = "log2_RMA"
adata.uns["normalization"] = "quantile"

adata.write_h5ad("microarray_processed.h5ad")
```

## Annotation: Mapping Probesets to Gene Symbols

```python
# Load platform-specific annotation package (e.g., HG-U133 Plus 2.0)
annotdbi = importr("AnnotationDbi")
hgu133plus2 = importr("hgu133plus2.db")

probeset_ids = ro.StrVector(expr_df.index.tolist())
mapping = ro.r('''function(ids) {
    AnnotationDbi::select(hgu133plus2.db, keys=ids,
        columns=c("SYMBOL","ENTREZID"), keytype="PROBEID")
}''')(probeset_ids)
mapping_df = r_to_pd(mapping)

gene_map = mapping_df.drop_duplicates(subset="PROBEID").set_index("PROBEID")
adata.var["gene_symbol"] = gene_map.reindex(adata.var_names)["SYMBOL"].values
```

## Gotchas

- oligo is the preferred package for all Affymetrix arrays. affy only supports older 3' IVT designs.
- RMA output is on log2 scale. Do NOT exponentiate before DE analysis with limma. Do NOT pass to DESeq2/edgeR (they need raw integer counts).
- `read.celfiles` in rpy2 maps to `read_celfiles` (dot to underscore).
- For Gene ST arrays, use `target="core"` in `oligo.rma()` for gene-level summarization.
- `mas5calls` is only available in the affy package for 3' IVT arrays. For newer arrays, use expression-level filtering instead.
- CEL file names often become sample names. Rename via `phenoData` at read time or post-hoc via `sampleNames()`.
- Annotation packages must match the exact array platform. Check with `ro.r("annotation")(raw_data)`.
- The platform annotation and `pd.*` design packages (`hgu133plus2.db`, `pd.hugene.1.0.st.v1`, …) are ordinarily installed on demand from Bioconductor. **The sandbox has no network access**, so `importr` on a package that is not already staged fails and cannot be fixed by installing it. Check what is available before planning the annotation step; if the package for this array is absent, emit probeset-level results and report that symbol mapping could not be done — do not fabricate a probeset-to-symbol mapping.
- `listGzipped=TRUE` in `list.celfiles` allows reading compressed `.CEL.gz` files directly.
- When converting to AnnData, remember the orientation flip: R is genes-as-rows; AnnData is samples-as-rows.
