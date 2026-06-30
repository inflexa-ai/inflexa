# SCGLUE API Reference

Graph-Linked Unified Embedding for single-cell multi-omics integration. Uses a guidance graph encoding biological relationships between features (e.g., gene-peak genomic proximity) to learn a shared latent space across modalities.

## Import

```python
import scglue
import anndata as ad
import scanpy as sc
import networkx as nx
import pandas as pd
```

## Preprocessing

### RNA

```python
rna = ad.read_h5ad("rna.h5ad")
sc.pp.normalize_total(rna)
sc.pp.log1p(rna)
sc.pp.highly_variable_genes(rna, n_top_genes=2000)
sc.pp.pca(rna, n_comps=100)
```

### ATAC

```python
atac = ad.read_h5ad("atac.h5ad")

# SCGLUE provides its own LSI implementation
scglue.data.lsi(atac, n_components=100, use_highly_variable=False)
# Result stored in atac.obsm['X_lsi']
```

### Genomic Coordinate Requirements

Both RNA and ATAC `.var` must have genomic coordinates for guidance graph construction:

```python
# rna.var must contain: chrom, chromStart, chromEnd, strand
# Example:
#            chrom  chromStart  chromEnd strand
# CD3E       chr11    118209789 118213459      -

# atac.var must contain: chrom, chromStart, chromEnd
# Example (peaks):
#                        chrom  chromStart  chromEnd
# chr1:10000-10500       chr1       10000     10500
```

## Guidance Graph Construction

The guidance graph encodes known biological relationships between features across modalities (e.g., peaks near genes).

```python
guidance = scglue.genomics.rna_anchored_guidance_graph(
    rna,
    atac,
    gene_region="combined",     # "combined" = gene body + promoter
    promoter_len=2000,          # 2kb upstream promoter
    extend_range=150000,        # 150kb extension window for peak-gene links
    propagate_highly_variable=True  # propagate HVG status to connected ATAC peaks
)

# Validate the graph
scglue.graph.check_graph(guidance, [rna, atac])

print(f"Nodes: {guidance.number_of_nodes()}")
print(f"Edges: {guidance.number_of_edges()}")

# Save / load
nx.write_graphml(guidance, "guidance.graphml.gz")
guidance = nx.read_graphml("guidance.graphml.gz")
```

### Graph Structure

- Nodes = features (genes + peaks)
- Edges = biological relationships:
  - Peak overlaps gene body/promoter (direct evidence)
  - Peak within `extend_range` of gene (proximity evidence)
- Self-loops on every feature (required by SCGLUE architecture)
- The graph is a `networkx.MultiDiGraph`

## Configure Datasets

Before training, each AnnData must be configured with its probabilistic model and representation.

```python
scglue.models.configure_dataset(
    rna,
    prob_model="NB",            # Negative Binomial for RNA counts
    use_highly_variable=True,
    use_rep="X_pca",            # Pre-computed representation
    use_batch="batch"           # Batch key in .obs (or None)
)

scglue.models.configure_dataset(
    atac,
    prob_model="NB",            # NB also works for binarized ATAC
    use_highly_variable=True,
    use_rep="X_lsi",            # LSI representation
    use_batch="batch"
)
```

### Probabilistic Model Options

| prob_model | Use for |
|------------|---------|
| `"NB"` | Count data (RNA, binarized ATAC) |
| `"Normal"` | Continuous / log-normalized data |
| `"ZIN"` | Zero-inflated normal |
| `"ZINB"` | Zero-inflated negative binomial |

## Training with fit_SCGLUE

`fit_SCGLUE` automates pretraining, balancing weight estimation, and fine-tuning.

```python
glue = scglue.models.fit_SCGLUE(
    {"rna": rna, "atac": atac},      # dict of configured AnnData objects
    guidance,                          # guidance graph
    init_kws={
        "latent_dim": 50,             # latent space dimensions
        "h_depth": 2,                 # encoder hidden layer depth
        "h_dim": 256                  # encoder hidden layer size
    },
    compile_kws={"lr": 2e-3},
    fit_kws={
        "neg_samples": 10,
        "data_batch_size": 128,
        "graph_batch_size": None,      # None = use full graph
        "directory": "glue_output"     # checkpoint directory
    }
)
```

### Key Parameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| `latent_dim` | 50 | Shared latent space dimensions |
| `h_depth` | 2 | Number of hidden layers |
| `h_dim` | 256 | Hidden layer width |
| `lr` | 2e-3 | Learning rate |
| `neg_samples` | 10 | Negative samples for graph contrastive loss |
| `data_batch_size` | 128 | Mini-batch size for data likelihood |

## Extract Cell Embeddings

```python
# Per-modality embeddings in the shared latent space
rna.obsm["X_glue"] = glue.encode_data("rna", rna)
atac.obsm["X_glue"] = glue.encode_data("atac", atac)

# Downstream: combine and cluster
import numpy as np
combined = ad.concat([rna, atac], label="modality")
sc.pp.neighbors(combined, use_rep="X_glue")
sc.tl.umap(combined)
sc.tl.leiden(combined, resolution=0.5)
```

## Feature Embeddings

SCGLUE also learns embeddings for features (genes, peaks) via the guidance graph.

```python
feature_embeddings = glue.encode_graph(guidance)
feature_df = pd.DataFrame(feature_embeddings, index=glue.vertices)

# Assign to modality AnnData objects
rna.varm["X_glue"] = feature_df.reindex(rna.var_names).to_numpy()
atac.varm["X_glue"] = feature_df.reindex(atac.var_names).to_numpy()
```

## Regulatory Inference

Use feature embeddings to infer gene-peak regulatory relationships.

```python
# Build skeleton graph (subset of guidance with forward edges)
skeleton = guidance.edge_subgraph([
    e for e in guidance.edges
    if guidance.edges[e].get("type") == "fwd"
])

# Compute regulatory scores
regulatory = scglue.genomics.regulatory_inference(
    features=glue.vertices,
    feature_embeddings=feature_embeddings,
    skeleton=skeleton,
    alternative="greater",
    random_state=0
)

# Extract significant edges
edges = nx.to_pandas_edgelist(regulatory)
significant = edges[edges["qval"] < 0.05]
print(f"Significant regulatory links: {len(significant)}")
```

## Save / Load Model

```python
glue.save("glue_model.dill")
glue = scglue.models.load_model("glue_model.dill")
```

## Complete RNA + ATAC Workflow

```python
import scglue
import anndata as ad
import scanpy as sc
import networkx as nx

# 1. Load and preprocess
rna = ad.read_h5ad("rna.h5ad")
sc.pp.normalize_total(rna)
sc.pp.log1p(rna)
sc.pp.highly_variable_genes(rna, n_top_genes=2000)
sc.pp.pca(rna, n_comps=100)

atac = ad.read_h5ad("atac.h5ad")
scglue.data.lsi(atac, n_components=100, use_highly_variable=False)

# 2. Build guidance graph
guidance = scglue.genomics.rna_anchored_guidance_graph(
    rna, atac, extend_range=150000, propagate_highly_variable=True
)
scglue.graph.check_graph(guidance, [rna, atac])

# 3. Configure datasets
scglue.models.configure_dataset(rna, prob_model="NB", use_highly_variable=True, use_rep="X_pca")
scglue.models.configure_dataset(atac, prob_model="NB", use_highly_variable=True, use_rep="X_lsi")

# 4. Train
glue = scglue.models.fit_SCGLUE(
    {"rna": rna, "atac": atac}, guidance,
    init_kws={"latent_dim": 50}, fit_kws={"directory": "glue_output"}
)

# 5. Extract embeddings
rna.obsm["X_glue"] = glue.encode_data("rna", rna)
atac.obsm["X_glue"] = glue.encode_data("atac", atac)

# 6. Combined analysis
combined = ad.concat([rna, atac], label="modality")
sc.pp.neighbors(combined, use_rep="X_glue")
sc.tl.umap(combined)
sc.tl.leiden(combined, resolution=0.5)

glue.save("glue_model.dill")
```

## Gotchas

- `.var` must have genomic coordinates (`chrom`, `chromStart`, `chromEnd`) for both RNA and ATAC. Missing coordinates cause `rna_anchored_guidance_graph` to silently skip features.
- Always call `scglue.graph.check_graph()` after building the guidance graph. It validates coverage, edge attributes, self-loops, and symmetry.
- `configure_dataset()` must be called on each AnnData before `fit_SCGLUE()`. Configuration is stored in `adata.uns`.
- SCGLUE uses separate AnnData objects per modality (not MuData). Each modality is passed as a dict entry.
- `scglue.data.lsi()` is SCGLUE's own LSI. It differs from muon's `ac.tl.lsi()` — use the one matching your workflow.
- The model is saved with `dill` (not pickle). Ensure `dill` is installed.
- GPU is strongly recommended for training: set `fit_kws={"directory": "glue_output"}` and SCGLUE auto-detects GPU availability.
- `extend_range=150000` (150kb) is the standard window for peak-gene proximity. Smaller values may miss distal enhancers; larger values increase false positives.
