---
name: spatial-omics
description: Spatial transcriptomics and spatial proteomics analysis covering technology-specific workflows, spatial statistics, deconvolution, and niche analysis
version: 1.0.0
tags: [visium, merfish, slide-seq, codex, spatial, squidpy, spatialdata]
---

# Spatial Omics Analysis

Method selection and execution guidance for spatial transcriptomics and spatial proteomics technologies.

## Technology Detection

Identify the spatial platform first — resolution and data structure dictate the analysis approach:

```
Technology?
├── Visium (10x Genomics)
│   ├── Resolution: ~55 um spots, each covering ~1-10 cells
│   ├── Data: spot x gene count matrix + tissue image + spot coordinates
│   ├── Coordinate type: grid (hexagonal array)
│   └── Load: sc.read_visium() or sd.read_10x_visium()
│
├── MERFISH / seqFISH / Xenium (single-molecule FISH)
│   ├── Resolution: subcellular, single-molecule
│   ├── Data: molecule coordinates → cell x gene matrix after segmentation
│   ├── Coordinate type: generic (continuous coordinates)
│   └── Load: sd.read_xenium() or custom from segmentation output
│
├── Slide-seq / HDST (bead-based capture)
│   ├── Resolution: ~10 um beads (near single-cell)
│   ├── Data: bead x gene count matrix + bead coordinates
│   ├── Coordinate type: generic
│   └── Load: custom AnnData with .obsm["spatial"]
│
└── CODEX / MIBI / IMC (spatial proteomics)
    ├── Resolution: single-cell (after segmentation)
    ├── Data: cell x protein intensity matrix + coordinates
    ├── Coordinate type: generic
    └── Load: custom AnnData with .obsm["spatial"]
```

## Analysis Decision Tree

### Spatial Neighbors Graph

```
Building spatial graph (foundation for all spatial stats):
├── Visium → sq.gr.spatial_neighbors(adata, coord_type="grid")
│   Uses hexagonal grid adjacency, not distance
├── All other technologies → sq.gr.spatial_neighbors(adata, coord_type="generic")
│   ├── n_neighs=6 (default, good starting point)
│   └── Or radius-based: radius=float for distance threshold
└── Result stored in adata.obsp["spatial_connectivities"], adata.obsp["spatial_distances"]
```

### Spatial Domain Identification

```
Approach?
├── Graph-based clustering
│   ├── Standard → Leiden on spatial graph (sq.gr.spatial_neighbors → sc.tl.leiden)
│   └── Combined expression + spatial → compute joint graph (expression kNN + spatial kNN)
└── Visium-specific
    └── BayesSpace (R via rpy2, Bayesian spatial clustering, respects tissue morphology)
```

### Spatial Deconvolution (spot-based technologies)

```
Deconvolving multi-cell spots into cell type proportions:
├── cell2location (default, Bayesian, probabilistic)
│   ├── Requires matched scRNA-seq reference
│   ├── Stage 1: Learn reference signatures (RegressionModel)
│   ├── Stage 2: Decompose spatial spots (Cell2location model)
│   └── Returns: adata.obsm with cell type abundance per spot
├── stereoscope (alternative Bayesian, similar approach)
└── RCTD (R-based, robust non-negative least squares)
```

### Spatially Variable Genes

```
Testing for spatial expression patterns:
├── Global autocorrelation
│   ├── Moran's I → sq.gr.spatial_autocorr(adata, mode="moran")
│   │   Range: -1 (dispersed) to +1 (clustered), 0 = random
│   └── Geary's C → sq.gr.spatial_autocorr(adata, mode="geary")
│       Range: 0 (clustered) to >1 (dispersed), 1 = random
└── Local autocorrelation (per-spot patterns)
    └── Local Moran's I via custom computation or PySAL
```

### Niche / Microenvironment Analysis

```
Spatial niche characterization:
├── Neighborhood enrichment
│   └── sq.gr.nhood_enrichment(adata, cluster_key="leiden")
│       Tests whether cell type pairs co-occur more than expected
├── Co-occurrence analysis
│   └── sq.gr.co_occurrence(adata, cluster_key="leiden")
│       Distance-dependent co-occurrence probability
└── Ligand-receptor in spatial context
    └── sq.gr.ligrec(adata, cluster_key="leiden")
        Spatially-constrained ligand-receptor interaction testing
```

## SpatialData Framework

For complex experiments with multiple tissue sections, coordinate transformations, or image analysis, use SpatialData as the container:

- `sd.SpatialData` holds images, labels, shapes, points, and annotation tables.
- Coordinate systems and transformations handle alignment across modalities.
- Integrates with squidpy for spatial statistics via `sd.get.spatial_element()`.

## Output Conventions

- Save processed data as AnnData .h5ad with `adata.obsm["spatial"]` coordinates preserved.
- Spatial scatter plots: gene expression overlaid on tissue coordinates as PNG/PDF.
- Spatial domain map: cluster assignments on tissue coordinates.
- Deconvolution results: cell type proportion maps per spot.
- Spatial autocorrelation results as CSV: gene, morans_I, pval_norm, padj.
- Niche enrichment heatmap: cell type pair enrichment z-scores.

## Anti-Patterns

- **Ignoring spatial resolution limits**: Visium spots contain multiple cells. Do not interpret spot-level expression as single-cell. Use deconvolution to estimate cell type composition.
- **Wrong coordinate system**: Using `coord_type="grid"` for non-Visium data (or vice versa) produces incorrect spatial graphs. Visium uses hexagonal grid; everything else uses generic continuous coordinates.
- **Applying scRNA-seq methods without spatial awareness**: Standard clustering on expression alone ignores spatial structure. Combine expression and spatial graphs, or use spatially-aware methods.
- **Deconvolution without matched scRNA-seq reference**: cell2location and similar methods require a reference dataset from the same tissue type. Using a mismatched reference produces unreliable cell type estimates.
- **Spatial autocorrelation without multiple testing correction**: Testing thousands of genes for spatial patterns requires FDR correction. Always use adjusted p-values.
- **Ignoring tissue morphology**: H&E images (Visium) contain valuable information. Use image features alongside expression for richer domain identification.
- **Wrong distance metric for niche analysis**: Ensure spatial neighbor distances are in consistent units (um or pixels). Mixing coordinate scales across analyses produces inconsistent results.
- **Treating MERFISH like Visium**: Single-molecule technologies have different sparsity patterns and resolution. Do not apply Visium-specific methods (BayesSpace, grid-based neighbors) to MERFISH data.

## References

API references for all supported packages:

- `references/squidpy-api.md` — Spatial statistics, neighbor graphs, niche analysis, LR testing
- `references/spatialdata-api.md` — Universal spatial data container with coordinate transformations
- `references/cell2location-api.md` — Bayesian spatial deconvolution from scRNA-seq reference
