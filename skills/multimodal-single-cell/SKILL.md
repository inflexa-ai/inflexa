---
name: multimodal-single-cell
description: Read before you analyze single cells with two or more modalities (RNA and surface protein, RNA and chromatin accessibility, or three modalities). It gives the joint method for each assay, the QC for each modality, and the normalization traps of protein and accessibility data.
metadata:
  version: 1.0.0
  tags: [cite-seq, multiome, tea-seq, dogma-seq, mudata, multimodal]
  category: transcriptomics
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
│   │       PREREQUISITE: rna.var needs chrom/chromStart/chromEnd, which
│   │       normally require a GTF — none is available. Check whether the
│   │       data already carries them; if not, report the blocker and
│   │       fall back to MultiVI. See references/scglue-api.md.
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
│       Gated on RNA genomic coordinates being present — see above.
└── Protein marker quantification
    └── Per-protein analysis from TOTALVI denoised values or DSB-normalized
```

## Integration Constraints

- **TOTALVI**: Keep the RNA counts in `adata.X` and the protein counts in `adata.obsm["protein_expression"]`. Give the key to `setup_anndata` with `protein_expression_obsm_key`, and cluster on `X_totalVI`.
- **MultiVI**: Use `scvi.model.MULTIVI.setup_mudata`. `setup_anndata` is deprecated for MULTIVI since scvi-tools 1.4. Give `n_genes` and `n_regions` to the model, because the model cannot find the boundary between the RNA and the ATAC features.
- **WNN via muon**: Compute the PCA (RNA) or the LSI (ATAC) and the neighbors of each modality first. Then run `mu.pp.neighbors(mdata, key_added="wnn")`, and cluster with `neighbors_key="wnn"`.

## Output Conventions

- Save processed data as MuData (.h5mu) with per-modality layers preserved.
- Per-modality QC metrics as CSV or in MuData .obs.

## Anti-Patterns

- **GLUE without genomic coordinates**: GLUE must have `chrom`, `chromStart`, and `chromEnd` in `rna.var`. A GTF usually gives them, and no GTF is available. If the data does not carry the coordinates, report the blocker and use MultiVI.
- **Treating protein data like RNA**: Protein counts have a different noise model (ambient antibody background, non-specific binding). Use TOTALVI or DSB normalization, not standard scRNA-seq normalization.
- **Ignoring ambient protein signal in CITE-seq**: The isotype controls show the background level. Without a correction, the ambient signal controls the low-expression proteins.
- **Joint analysis before per-modality QC**: Each modality has its own QC metrics and feature selection. A cell that passes RNA QC can fail ATAC QC, and a joint embedding hides the problem.
- **Applying scRNA-seq normalization to ATAC**: ATAC data is binary/sparse. Use TF-IDF + LSI (via `mu.atac.pp.tfidf` + `mu.atac.tl.lsi`), not normalize_total + log1p.
- **WNN without per-modality QC**: WNN lowers the weight of a low-quality modality for each cell only when the QC of each modality ran first.

## References

API references for all supported packages:

- `references/mudata-api.md` — MuData container for multi-modal data
- `references/muon-api.md` — Multi-modal analysis framework (WNN, ATAC processing, protein tools)
- `references/scvi-totalvi-api.md` — TOTALVI for CITE-seq (RNA + protein joint model)
- `references/scvi-multivi-api.md` — MultiVI for Multiome (RNA + ATAC joint model)
- `references/scglue-api.md` — GLUE graph-linked embedding for regulatory inference
