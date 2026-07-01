---
name: multimodal-single-cell
description: Multi-modal single-cell analysis for CITE-seq, Multiome, TEA-seq, and DOGMA-seq including joint embedding, per-modality QC, and cross-modal integration
version: 1.0.0
tags: [cite-seq, multiome, tea-seq, dogma-seq, mudata, multimodal]
---

# Multimodal Single-Cell Analysis

Method selection and execution guidance for multi-modal single-cell assays (RNA+protein, RNA+ATAC, 3+ modalities).

## Data Container

Always use MuData (.h5mu) as the container for multi-modal data. Each modality is a separate AnnData accessible via `mdata.mod['rna']`, `mdata.mod['prot']`, `mdata.mod['atac']`, etc. Do NOT store multiple modalities in a single AnnData object.

## Technology Detection and Method Selection

```
Assay type?
├── CITE-seq (RNA + surface protein)
│   ├── Joint embedding (default)
│   │   ├── TOTALVI (probabilistic, handles protein background noise, default)
│   │   └── WNN via muon (quick baseline, weighted nearest neighbors)
│   └── Per-modality analysis → process RNA and protein separately, then integrate
│
├── Multiome (RNA + ATAC)
│   ├── Joint embedding (default)
│   │   ├── MultiVI (probabilistic, handles missing modalities, default)
│   │   └── GLUE (graph-linked embedding, best for regulatory inference)
│   └── Per-modality analysis → scanpy for RNA, muon.atac for ATAC, then combine
│
├── TEA-seq / DOGMA-seq (RNA + protein + ATAC, 3 modalities)
│   └── WNN via muon (most flexible for >2 modalities)
│       ├── Compute per-modality neighbors
│       ├── mu.pp.neighbors(mdata, key_added="wnn", ...) with multi-modal weights
│       └── Cluster on WNN graph
│
└── Other combinations
    └── WNN via muon (generalizes to any number of modalities)
```

## Per-Modality QC

Each modality has distinct noise characteristics. QC must be run separately before integration.

```
Modality QC:
├── RNA
│   ├── Standard scRNA-seq QC (MAD-based thresholds)
│   ├── n_genes, total_counts, pct_mito
│   └── Doublet detection (scrublet or SOLO)
│
├── Protein (CITE-seq)
│   ├── Isotype control check: background level from isotype control antibodies
│   ├── Ambient protein correction: DSB normalization or CLR (centered log-ratio)
│   ├── Filter proteins with low detection across cells
│   └── Check for antibody aggregation artifacts (unusually high counts across all proteins)
│
└── ATAC
    ├── TSS enrichment score (>2 acceptable, >5 good)
    ├── Nucleosome signal (<4 good, banding pattern in fragment size distribution)
    ├── Fraction of reads in peaks (FRiP > 0.3)
    ├── Total fragments (>1000)
    └── mu.atac.tl.nucleosome_signal(mdata.mod['atac'])
```

## Joint vs Separate Embedding

```
Analysis goal?
├── Cell type discovery / clustering → Joint embedding (captures cross-modal signal)
├── Modality-specific biology (e.g., chromatin accessibility patterns)
│   └── Separate per-modality analysis, then compare
├── Regulatory inference (TF → peak → gene)
│   └── GLUE (preserves feature-level relationships across modalities)
└── Protein marker quantification
    └── Per-protein analysis from TOTALVI denoised values or DSB-normalized
```

## Integration Workflow

### CITE-seq with TOTALVI

1. Store RNA counts in `adata.X`, protein counts in `adata.obsm["protein_expression"]`.
2. `scvi.model.TOTALVI.setup_anndata(adata, protein_expression_obsm_key="protein_expression", batch_key="batch")`.
3. Train: `model = scvi.model.TOTALVI(adata); model.train()`.
4. Extract: `adata.obsm["X_totalVI"] = model.get_latent_representation()`.
5. Denoised protein: `_, protein_fg = model.get_normalized_expression(n_samples=25, return_mean=True)`.
6. Cluster on `X_totalVI` embedding.

### Multiome with MultiVI

1. Store RNA and ATAC in MuData: `mdata.mod['rna']`, `mdata.mod['atac']`.
2. `scvi.model.MULTIVI.setup_mudata(mdata, ...)`.
3. Train: `model = scvi.model.MULTIVI(mdata); model.train()`.
4. Extract joint latent space for clustering.
5. Impute missing modalities if cells have only one modality.

### WNN via muon (any combination)

1. Compute per-modality PCA/LSI: `sc.pp.pca(mdata.mod['rna'])`, `mu.atac.tl.lsi(mdata.mod['atac'])`.
2. Compute per-modality neighbors: `sc.pp.neighbors(mdata.mod['rna'])`, etc.
3. Compute WNN: `mu.pp.neighbors(mdata, key_added="wnn")`.
4. Cluster: `sc.tl.leiden(mdata, neighbors_key="wnn")`.
5. Visualize: `mu.tl.umap(mdata, neighbors_key="wnn")`.

## Output Conventions

- Save processed data as MuData (.h5mu) with per-modality layers preserved.
- Joint UMAP colored by cluster, cell type, batch, and modality-specific markers.
- Per-modality QC metrics as CSV or in MuData .obs.
- Protein heatmap for CITE-seq (denoised protein expression by cluster).
- Peak accessibility browser tracks or aggregate profiles for ATAC.

## Anti-Patterns

- **Treating protein data like RNA**: Protein counts have a different noise model (ambient antibody background, non-specific binding). Use TOTALVI or DSB normalization, not standard scRNA-seq normalization.
- **Ignoring ambient protein signal in CITE-seq**: Isotype controls reveal background levels. Without correction, low-expression proteins are dominated by ambient signal.
- **Not running per-modality QC before integration**: Each modality has distinct quality metrics. Cells passing RNA QC may fail ATAC QC (low TSS enrichment). Filter per-modality first.
- **Using AnnData instead of MuData**: Cramming multiple modalities into a single AnnData (e.g., concatenating RNA and protein features) loses modality structure and breaks downstream tools. Always use MuData.
- **Applying scRNA-seq normalization to ATAC**: ATAC data is binary/sparse. Use TF-IDF + LSI (via `mu.atac.pp.tfidf` + `mu.atac.tl.lsi`), not normalize_total + log1p.
- **Joint embedding without per-modality preprocessing**: Each modality needs its own feature selection and dimensionality reduction before joint integration.
- **Ignoring modality weights in WNN**: WNN computes per-cell modality weights. Cells where one modality is low-quality will down-weight it automatically, but only if per-modality QC was run.

## References

API references for all supported packages:

- `references/mudata-api.md` — MuData container for multi-modal data
- `references/muon-api.md` — Multi-modal analysis framework (WNN, ATAC processing, protein tools)
- `references/scvi-totalvi-api.md` — TOTALVI for CITE-seq (RNA + protein joint model)
- `references/scvi-multivi-api.md` — MultiVI for Multiome (RNA + ATAC joint model)
- `references/scglue-api.md` — GLUE graph-linked embedding for regulatory inference
