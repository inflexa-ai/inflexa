---
name: spatial-omics
description: Read before you analyze spatial transcriptomics or spatial proteomics data. It tells how the platform resolution changes the neighbor graph, domains, and deconvolution, which spatial methods cannot run here, and the traps of spots that hold more than one cell.
metadata:
  version: 1.0.0
  tags: [visium, merfish, slide-seq, codex, spatial, squidpy, spatialdata]
  category: transcriptomics
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
│   └── Load: sq.read.visium() or sd.read_10x_visium()
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
│   ├── Requires a matched scRNA-seq reference — USER-SUPPLIED, none is
│   │   bundled or downloadable. No reference => report the blocker.
│   ├── Stage 1: Learn reference signatures (RegressionModel)
│   ├── Stage 2: Decompose spatial spots (Cell2location model)
│   └── Returns: adata.obsm with cell type abundance per spot
└── RCTD (R-based, robust non-negative least squares; spacexr via rpy2)
    Also needs a user-supplied scRNA-seq reference.

Note: stereoscope is NOT available and cannot be installed. Do not
propose it. Every deconvolution route requires a user-supplied reference.
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
    └── Local Moran's I / Getis-Ord G via libpysal (spatial weights) + esda
        Build weights from the spot coordinates, not from a raster grid
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
    └── UNAVAILABLE — sq.gr.ligrec cannot run here (missing package + no
        network for its interaction database). Report the blocker; do not
        substitute another analysis silently. See references/squidpy-api.md.
```

## SpatialData Framework

For more than one tissue section, coordinate transformations, or image analysis, use `sd.SpatialData` as the container. Read `references/spatialdata-api.md`.

## Output Conventions

- Save processed data as AnnData .h5ad with `adata.obsm["spatial"]` coordinates preserved.
- Spatial autocorrelation results as CSV: gene, morans_I, pval_norm, padj.

## Anti-Patterns

- **Deconvolution without a user-supplied reference**: No scRNA-seq reference is bundled, and none can be downloaded. If the user gave no reference from the same tissue, report the blocker. A reference from a different tissue gives unreliable estimates.
- **stereoscope**: It is not installed and cannot be installed. Do not propose it.
- **`sq.gr.ligrec`**: Its package is absent, and its interaction database uses the network. Report the blocker. Do not put a different analysis in its place without a statement.
- **Wrong coordinate system**: `coord_type="grid"` is for Visium only. All other platforms use `coord_type="generic"`. The wrong type gives an incorrect spatial graph with no error.
- **Ignoring spatial resolution limits**: Visium spots contain multiple cells. Do not interpret spot-level expression as single-cell. Use deconvolution to estimate cell type composition.
- **Clustering on expression alone**: It ignores the spatial structure. Combine the expression and the spatial graphs, or use a spatially-aware method.
- **Spatial autocorrelation without FDR**: A test of thousands of genes needs adjusted p-values.
- **Ignoring the tissue image**: The H&E image (Visium) carries information. Use image features with the expression for the domains.
- **Mixed distance units**: Keep the neighbor distances in one unit (µm or pixels) across the analyses.
- **Treating MERFISH like Visium**: Do not use Visium-specific methods (BayesSpace, grid neighbors) on single-molecule data.

## References

API references for all supported packages:

- `references/squidpy-api.md` — Spatial statistics, neighbor graphs, niche analysis, LR testing
- `references/spatialdata-api.md` — Universal spatial data container with coordinate transformations
- `references/cell2location-api.md` — Bayesian spatial deconvolution from scRNA-seq reference
