# Spatial Proteomics → MDV (CODEX/PhenoCycler, IMC, MIBI)

The rows are segmented cells, the features are markers (antibodies or metal tags), and the
values are the intensities of each cell. The project has the same shape as a spatial
transcriptomics project: the cells on the multichannel image, with markers in place of genes.
Make the store and the project as `spatial-transcriptomics.md` tells (`put_table`,
`drop_unused`, `write_spatial_project`).

## Inputs

| Platform | Reader |
|---|---|
| CODEX / PhenoCycler | `spatialdata_io.codex` |
| IMC (Hyperion), steinbock output | `spatialdata_io.steinbock` |
| MCMICRO output | `spatialdata_io.mcmicro` |
| MIBI, or an output that no reader accepts | build the store (below) from the image stack and the cell table of the segmentation tool |

Identify the marker columns by name. Separate them from the morphology columns (area,
eccentricity, perimeter), the position columns, and the background or empty channels. `Xe131`,
`DNA1`, and `DNA2` are not cell-type markers. Keep them as QC columns.

Make one project for each ROI, as for each slide. The view "Tissue" opens on one region.

## Build the AnnData

```python
import anndata as ad, numpy as np, pandas as pd, scipy.sparse as sp

markers = [...]                                   # the antibody columns, by name
raw = cells[markers].to_numpy(dtype=np.float32)
adata = ad.AnnData(X=sp.csr_matrix(np.arcsinh(raw / COFACTOR)), obs=cells.drop(columns=markers),
                   var=pd.DataFrame(index=[clean_marker_name(m) for m in markers]))
adata.layers["raw"] = sp.csr_matrix(raw)
```

If a reader gives the table, its X holds the raw mean intensities. Move them to the layer `raw`,
and put the transformed values in X.

- **Transform.** `arcsinh(x / cofactor)`. Use a cofactor of 5 for CyTOF-like IMC counts, and
  about 150 for fluorescence (CODEX). Write it in the README. Store X sparse, also when it is
  almost full: the asset contract tells you to, and a cells × markers matrix is small.
- **Marker names.** Readable and unique: `CD3e`, not `Er170Di_CD3e`. Never `|` or `(`
  (`Ki-67` is permitted, `Ki67 (clone X)` is not). Keep the channel tag as a `var` column.
- **Coordinates.** Keep the coordinates of the store. Do not flip y.
- **Clusters.** Use the markers that define lineages, not the functional or DNA channels. Run
  Leiden on a kNN graph of the scaled lineage markers. Label the clusters with lineage markers
  (`annotate_clusters` with the marker lists of the tissue). There is no HVG selection.

## Build a store with no reader

```python
import spatialdata as sd
from spatialdata.models import Image2DModel, ShapesModel, TableModel
from spatialdata.transformations import Identity, Scale

image = Image2DModel.parse(stack, dims=("c", "y", "x"), c_coords=channel_names, scale_factors=[2, 2, 2, 2],
                           transformations={"global": Scale([UM_PER_PX, UM_PER_PX], axes=("y", "x"))})
ids = np.arange(adata.n_obs)
radius = np.sqrt(adata.obs["area_um2"].to_numpy() / np.pi)
cells = ShapesModel.parse(np.asarray(adata.obsm["spatial"], dtype=float), geometry=0, radius=radius,
                          index=pd.Index(ids, name="cell"), transformations={"global": Identity()})
adata.obs["region"] = pd.Categorical(["cells"] * adata.n_obs)
adata.obs["instance_id"] = ids
table = TableModel.parse(adata, region="cells", region_key="region", instance_key="instance_id")
sdata = sd.SpatialData(images={"image": image}, shapes={"cells": cells}, tables={"table": table})
```

`obsm["spatial"]` holds the cell centers in µm, in the frame of the image. The IMC pixel size is
1 µm. The channel names must be unique.

## Make the project

Use the project route, with these changes:

- The genes table of MDV holds the markers. Write in the README that the "Gene Scores" are arcsinh
  marker intensities.
- Give the raw layer a label: `layers={"raw": "Mean intensity"}`. The matrix is small, and a
  person compares the raw and the transformed values.
- QC columns: the cell area, the total intensity, and the DNA intensity.
- Add a `rois` table with the cells of each ROI (`add_table`).

## Anti-patterns

- Raw intensities as X: the dynamic range hides most markers in each color scale.
- DNA, background, or empty channels as markers in the clusters.
- Some ROIs in one project: the view "Tissue" opens on one region only.
