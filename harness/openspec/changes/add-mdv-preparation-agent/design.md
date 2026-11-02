# Design

## Context

MDV loads an AnnData through its upload. The upload reads the `.h5ad` file and calls `convert_scanpy_to_mdv` of `mdvtools` with each default. The result is a table of cells, a table of genes, and the expression of each gene linked to the cells. The upload also takes CSV and TSV files, and each file becomes one table. MDV lists the `.h5ad` upload for its local development deployment.

## Decisions

### The deliverable is an asset, not a project

An MDV project needs `mdvtools`, and the package store does not hold it. Its exact pins conflict with the catalog. The asset is an AnnData that the default conversion of MDV makes into a correct, readable project. Thus the agent needs no new package, and MDV does the conversion with its own versions.

The asset cannot carry the views, the colors of the categories, or a tissue image. The README names the first charts to make. MDV gives the default palette.

### The label is the column name

The conversion uses the label of each column of the AnnData as the name of the MDV column, and MDV has no field for a description. Thus the asset uses labels with words and units, and the README gives the glossary.

### The validator reads the file as stored

The validator reads the HDF5 encodings with `h5py`, and it does not use the types that pandas shows in the step. pandas 3 (the arm64 store) writes the cell names and the gene names as a nullable string array. MDV reads that as the pandas `string` type, and the conversion stops. The helper module writes the names as plain strings and each text column as categorical. The validator gives an error for a nullable string array.

### One agent and one pack

The work is one task with one deliverable, for each modality. One plannable agent owns the task, and its capability phrases make the routing predictable. The agent also declares the modality packs. It reads them for the QC, the normalization, and the clustering of raw input.

### The pack ships code, and a test extracts it

A reference file holds each helper module in a fenced block that starts with `# file: <name>.py`. The agent copies the module into its step. A person can extract the blocks and run them.

### The orientation of a raw CosMx run is measured

The run files do not give the sign between the FOV axes and the stage axes. The reader scores the four sign hypotheses by the continuity of neighbor FOV images across their seams. It refuses a result that does not win by a clear margin.

## Verification

- A CosMx 6K run (193,673 cells, 6,278 genes) went through the extracted modules with the exact amd64 pins of the store. The asset holds 183,350 cells after QC, and its size is 0.25 GB. The validator reported zero errors and zero warnings.
- The upload code of MDV (`scanpy.read`, then `convert_scanpy_to_mdv` with each default) converted the asset with the pins of `mdvtools` 1.3.0 (anndata 0.12.2, pandas 2.3.2). The project opened in a headless browser.
- A pandas 3 test with the arm64 pins showed the nullable string trap, and the asset of the helper module converted.
- Small multiome and proteomics assets with one layer each converted to two expression sets on one feature table.

## Risks

- The marker lists for cell types are a choice for each tissue. The pack gives the method and an example for adult human cortex, and it marks each label as putative.
- The production deployment of MDV lists only CSV, TSV, and TXT for the upload. The README tells the user which deployments accept the `.h5ad` file.
- No real scRNA-seq, scATAC-seq, multiome, or spatial proteomics data went through the pack.
