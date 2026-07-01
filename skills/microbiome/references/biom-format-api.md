# biom-format API Reference

Python library for working with BIOM (Biological Observation Matrix) tables. Bridges QIIME2 output with Python/pandas workflows. Handles OTU/ASV tables with observation and sample metadata.

## Core Imports

```python
from biom import load_table
from biom.table import Table
import numpy as np
import pandas as pd
```

## Loading BIOM Files

```python
# Load BIOM v1 (JSON) or v2 (HDF5)
table = load_table("feature-table.biom")

# Basic properties
print(f"Shape: {table.shape}")         # (n_observations, n_samples)
print(f"Observations: {table.shape[0]}")  # features/OTUs/ASVs
print(f"Samples: {table.shape[1]}")
print(f"Non-zero: {table.nnz}")
print(f"Format: {table.type}")
```

## Table Properties and Accessors

```python
# Sample and observation IDs
sample_ids = table.ids(axis="sample")       # numpy array of sample IDs
obs_ids = table.ids(axis="observation")     # numpy array of feature IDs

# Check if IDs exist
table.exists("SampleA", axis="sample")     # bool
table.exists("OTU_001", axis="observation") # bool
```

## Converting to pandas DataFrame

```python
# Full table to dense DataFrame (observations x samples)
df = table.to_dataframe()
# Index = observation IDs, columns = sample IDs
# WARNING: dense conversion can exhaust memory for large tables

# Sparse DataFrame (memory-efficient for large tables)
df_sparse = table.to_dataframe(dense=False)
# Returns DataFrame backed by scipy sparse matrix

# Transposed: samples as rows, features as columns
df_t = table.to_dataframe().T
```

## Converting from pandas DataFrame

```python
# Create BIOM Table from pandas DataFrame
# df: observations (OTUs) as rows, samples as columns
data = np.array([
    [10, 20, 0, 5],
    [0, 15, 8, 3],
    [7, 0, 12, 1],
])
obs_ids = ["OTU1", "OTU2", "OTU3"]
sample_ids = ["S1", "S2", "S3", "S4"]

table = Table(
    data,                    # 2D array-like (observations x samples)
    obs_ids,                 # observation (feature) IDs
    sample_ids,              # sample IDs
    type="OTU table",        # optional table type string
)

# From existing pandas DataFrame
df = pd.DataFrame(data, index=obs_ids, columns=sample_ids)
table = Table(
    df.values,
    list(df.index),
    list(df.columns),
)
```

## Metadata Access

```python
# Observation (feature) metadata
obs_meta = table.metadata(id="OTU_001", axis="observation")
# Returns dict or None

# Sample metadata
samp_meta = table.metadata(id="SampleA", axis="sample")

# All metadata as a list of dicts
all_obs_meta = [
    table.metadata(id=oid, axis="observation")
    for oid in table.ids(axis="observation")
]

# Convert metadata to DataFrame
obs_meta_df = pd.DataFrame(
    all_obs_meta,
    index=table.ids(axis="observation"),
)
```

## Adding Metadata

```python
# Add observation (taxonomy) metadata
taxonomy = {
    "OTU1": {"taxonomy": ["Bacteria", "Firmicutes", "Clostridia"]},
    "OTU2": {"taxonomy": ["Bacteria", "Bacteroidetes", "Bacteroidia"]},
    "OTU3": {"taxonomy": ["Bacteria", "Proteobacteria", "Gammaproteobacteria"]},
}
table.add_metadata(taxonomy, axis="observation")

# Add sample metadata
sample_meta = {
    "S1": {"group": "control", "age": 25},
    "S2": {"group": "treatment", "age": 30},
}
table.add_metadata(sample_meta, axis="sample")
```

## Filtering

```python
# Filter samples by ID
sample_subset = table.filter(
    ids_to_keep=["S1", "S2", "S3"],
    axis="sample",
    inplace=False,        # return new table, do not modify original
)

# Filter observations by ID
obs_subset = table.filter(
    ids_to_keep=["OTU1", "OTU3"],
    axis="observation",
    inplace=False,
)

# Filter by function (e.g., minimum total count per sample)
def min_count_filter(values, id_, metadata):
    return values.sum() >= 1000

filtered = table.filter(min_count_filter, axis="sample", inplace=False)

# Filter by prevalence (observations present in >= 10% of samples)
def prevalence_filter(values, id_, metadata):
    return (values > 0).sum() / len(values) >= 0.10

filtered = table.filter(prevalence_filter, axis="observation", inplace=False)

# Remove empty observations/samples after filtering
filtered = filtered.remove_empty(axis="observation")
filtered = filtered.remove_empty(axis="sample")
```

## Data Access and Manipulation

```python
# Get counts for a specific sample
sample_counts = table.data(id="S1", axis="sample", dense=True)
# Returns 1D numpy array (one value per observation)

# Get counts for a specific observation
obs_counts = table.data(id="OTU1", axis="observation", dense=True)
# Returns 1D numpy array (one value per sample)

# Sum per sample (library sizes)
sample_sums = np.array([table.data(sid, "sample", dense=True).sum()
                         for sid in table.ids("sample")])

# Or use built-in
sample_sums = table.sum(axis="sample")     # sum per sample
obs_sums = table.sum(axis="observation")   # sum per observation

# Normalize to relative abundance
def normalize(values, id_, metadata):
    return values / values.sum()

rel_table = table.norm(axis="sample", inplace=False)
```

## Collapsing (Taxonomic Agglomeration)

```python
# Collapse observations by taxonomy level
# Requires taxonomy metadata on observations
def collapse_by_phylum(id_, metadata):
    if metadata and "taxonomy" in metadata:
        tax = metadata["taxonomy"]
        if len(tax) >= 2:
            return tax[1]   # Phylum level (index 1)
    return "Unclassified"

phylum_table = table.collapse(
    collapse_by_phylum,
    axis="observation",
    norm=False,            # do not normalize after collapsing
    min_group_size=1,
    one_to_many=False,
)
```

## Format Conversion

```python
# Save as BIOM v2 (HDF5) — recommended for large tables
with open("output.biom", "wb") as f:
    table.to_hdf5(f, "Generated by analysis pipeline")

# Save as BIOM v1 (JSON)
with open("output_v1.biom", "w") as f:
    f.write(table.to_json("Generated by analysis pipeline"))

# Save as TSV (tab-separated)
with open("output.tsv", "w") as f:
    f.write(table.to_tsv())

# From TSV to BIOM
from biom import parse_table
with open("input.tsv") as f:
    table = parse_table(f)
```

## QIIME2 Integration

```python
# QIIME2 exports BIOM v2 tables. Load directly:
table = load_table("feature-table.biom")

# Extract taxonomy from QIIME2 taxonomy.tsv and add to BIOM table
tax_df = pd.read_csv("taxonomy.tsv", sep="\t", index_col=0, comment="#")
taxonomy = {}
for feat_id, row in tax_df.iterrows():
    lineage = row["Taxon"].split("; ")
    taxonomy[feat_id] = {"taxonomy": lineage}
table.add_metadata(taxonomy, axis="observation")

# Convert to phyloseq-compatible format via pandas
otu_df = table.to_dataframe()     # observations x samples
tax_list = [table.metadata(oid, "observation").get("taxonomy", [])
            for oid in table.ids("observation")]
```

## Gotchas

- BIOM v2 (HDF5) requires the `h5py` package. If not installed, `load_table()` on HDF5 files raises an `ImportError`.
- `to_dataframe()` creates a dense matrix. For tables with >100k features, this can exhaust memory. Use `to_dataframe(dense=False)` for sparse representation.
- BIOM tables are observations (features) x samples by convention. Pandas DataFrames from `to_dataframe()` follow this convention (features as rows). Transpose with `.T` if you need samples as rows.
- `filter()` with `inplace=True` modifies the table in place and returns `None`. Use `inplace=False` to get a new table.
- Taxonomy metadata from QIIME2 is stored as a semicolon-delimited string (e.g., `"k__Bacteria; p__Firmicutes; ..."`), not a list. Split before adding to BIOM.
- `Table()` constructor accepts scipy sparse matrices, numpy arrays, or lists. The data shape must be (n_observations, n_samples).
- `table.data()` returns a scipy sparse array by default. Pass `dense=True` to get a numpy array.
- `norm()` divides by sample sums (relative abundance). It does not log-transform. For CLR, compute manually after `to_dataframe()`.
