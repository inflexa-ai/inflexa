# Spatial Proteomics → MDV (CODEX/PhenoCycler, IMC, MIBI)

The rows are segmented cells, the features are markers (antibodies or metal tags), and the
values are per-cell intensities. The asset has the same shape as a spatial transcriptomics asset:
cells with slide coordinates, and markers in place of genes. These platforms come as
segmentation tables plus multichannel images.

## Inputs

| Platform | Cell table |
|---|---|
| CODEX / PhenoCycler | per-cell CSV/FCS from the segmentation tool (cell id, x, y, area, one column per marker) |
| IMC (Hyperion) | per-cell mean intensities from the segmentation pipeline (for example steinbock: `intensities/*.csv` + `regionprops/*.csv`) |
| MIBI | per-cell table from the segmentation tool |

Identify the marker columns explicitly. Separate them from morphology columns (area,
eccentricity, perimeter), position columns, and background or empty channels (`Xe131`, `DNA1` /
`DNA2` are not cell-type markers; keep them as QC columns).

## Build the AnnData

```python
import anndata as ad, numpy as np, pandas as pd, scipy.sparse as sp

markers = [...]                                   # the antibody columns, by name
raw = cells[markers].to_numpy(dtype=np.float32)
adata = ad.AnnData(X=sp.csr_matrix(np.arcsinh(raw / COFACTOR)), obs=cells.drop(columns=markers),
                   var=pd.DataFrame(index=[clean_marker_name(m) for m in markers]))
```

- **Transform.** `arcsinh(x / cofactor)`; cofactor 5 for CyTOF-like IMC counts, about 150 for
  fluorescence (CODEX). State it in the README. Store X sparse even when it is nearly full:
  the asset contract asks for sparse X, and a cells × markers matrix is small.
- **Marker names.** Readable and unique: `CD3e`, not `Er170Di_CD3e`; never `|` or `(`
  (`Ki-67` is fine, `Ki67 (clone X)` is not). Keep the channel tag as a `var` column.
- **Coordinates.** Pixels to µm with the pixel size of the platform (IMC: 1 µm/px); y flipped
  upwards. Several ROIs or FOVs: an `ROI` column (≤ 256 values), and offset each ROI in x so they
  do not overlap in a scatter plot.
- **Clustering.** Use the markers that define lineages (not the functional or DNA channels).
  Leiden on a kNN graph of the scaled lineage markers; label clusters with lineage markers
  (`annotate_clusters` with marker lists of the tissue). There is no HVG selection.

## Write the asset

The asset route, with these changes:

- The genes table of MDV holds the markers. Say in the README that "Gene Scores" are arcsinh
  marker intensities.
- Add the raw mean intensities as one layer, `layers={"raw": "Mean intensity"}`: the matrix is
  small, and people compare raw and transformed values.
- QC columns: cell area, total intensity, DNA intensity; `rois.tsv` with cells per ROI.

## Anti-patterns

- Raw intensities as X: the dynamic range hides most markers in every colour scale.
- DNA, background, or empty channels as markers in clustering.
- Several ROIs at the same coordinates: the cells draw on top of each other.
