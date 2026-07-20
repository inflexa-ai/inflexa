---
name: proteomics
description: Proteomics analysis covering DDA, DIA, TMT/iTRAQ, Olink, and SomaScan platforms including preprocessing, normalization, differential expression, and PTM analysis
version: 1.0.0
tags: [proteomics, dda, dia, tmt, olink, somascan, mass-spectrometry]
---

# Proteomics Analysis

Method selection and execution guidance for quantitative proteomics across mass spectrometry and affinity-based platforms.

## Platform Detection and Preprocessing

Identify the platform first — each has distinct data characteristics and preprocessing requirements:

```
Platform?
├── DDA (Data-Dependent Acquisition)
│   ├── Input: FragPipe/MaxQuant output → protein/peptide intensity matrix
│   ├── Preprocessing:
│   │   ├── 1. Filter by missingness (keep proteins detected in >= 70% of at least one group)
│   │   ├── 2. Log2 transform intensities
│   │   ├── 3. Normalize: VSN (variance stabilizing, preferred) or median centering
│   │   ├── 4. Impute missing values:
│   │   │   ├── MNAR (Missing Not At Random, below LOD) → MinProb (left-censored)
│   │   │   ├── MAR (Missing At Random, technical dropout) → kNN
│   │   │   └── Mixed → hybrid (MinProb for low-abundance, kNN for rest)
│   │   └── 5. Assess batch effects (PCA by batch)
│   └── DE: DEP test_diff (default) or limma via rpy2
│
├── DIA (Data-Independent Acquisition)
│   ├── Input: DIA-NN output → protein/precursor intensity matrix
│   ├── Preprocessing: Same as DDA but fewer missing values expected
│   │   ├── DIA-NN already provides normalized intensities (check MaxLFQ column)
│   │   └── If raw intensities: filter → log2 → normalize → impute as above
│   └── DE: DEP test_diff or limma via rpy2
│
├── TMT / iTRAQ (Isobaric Labeling)
│   ├── Input: FragPipe/MaxQuant PSM-level or protein-level quantification
│   ├── Preprocessing:
│   │   ├── 1. MSstatsTMT dataProcess (handles plex normalization, protein summarization)
│   │   ├── 2. Channel-level normalization (reference channel, global median)
│   │   └── 3. Between-plex normalization (bridge channel if available)
│   └── DE: MSstatsTMT groupComparison (handles plex as random effect)
│
├── Olink (Proximity Extension Assay)
│   ├── Input: NPX values (already log2-scale, plate-normalized)
│   ├── Preprocessing:
│   │   ├── 1. LOD filtering: flag assays below LOD per sample
│   │   ├── 2. Multi-plate: bridge normalization using bridge samples
│   │   ├── 3. QC warnings: remove samples/assays with QC_Warning flags
│   │   └── 4. No additional normalization needed (NPX is pre-normalized)
│   └── DE: limma via rpy2 (treats NPX as log2-intensity) or linear model
│
└── SomaScan (SOMAmer Aptamer)
    ├── Input: ADAT file → RFU (Relative Fluorescence Units) matrix
    ├── Preprocessing:
    │   ├── 1. ANML normalization (SomaScan standard, usually pre-applied)
    │   ├── 2. Log2 transform RFU values
    │   ├── 3. Filter: remove aptamers with high CV across controls
    │   └── 4. Plate/batch correction if multi-plate
    └── DE: limma via rpy2 on log2 RFU values
```

## Differential Expression Method Selection

```
Design complexity?
├── Simple (2 groups, no covariates)
│   ├── DDA/DIA → DEP test_diff (R via rpy2, wrapper around limma)
│   └── TMT → MSstatsTMT groupComparison
├── Complex (multiple factors, covariates, interactions)
│   ├── DDA/DIA/Olink/SomaScan → limma via rpy2 (full formula support)
│   └── TMT → MSstats groupComparison with contrast matrix
├── Longitudinal / repeated measures
│   └── dream (variancePartition) via rpy2 (mixed-effects model)
└── Paired samples
    └── limma with blocking factor or paired design matrix
```

## PTM Analysis (Phosphoproteomics)

```
Phosphoproteomics workflow:
├── Quantification: Site-level intensities (NOT protein rollup)
│   ├── FragPipe: STY_79.9663 modification
│   └── MaxQuant: Phospho (STY)Sites table
├── Normalization: Normalize to total proteome if available (correct for protein abundance changes)
├── DE: limma on log2 site-level intensities
├── Kinase activity: decoupler with a kinase-substrate network you resolved
│   ├── dc.mt.ulm(adata, net=ksn) where ksn = kinase-substrate network
│   └── NOTE: no kinase-substrate network is in the reference inventory, and
│       every decoupler built-in fetcher (dc.op.*) reaches the network, which
│       is blocked — so Omnipath/PhosphoSitePlus retrieval fails outright.
│       If none is available, report it and deliver site-level DE without
│       kinase activity; never invent a path or substitute a TF regulon.
└── Critical: Do NOT roll up phospho-sites to protein level — this loses site-specific information
```

## Preprocessing Workflow

1. **Load data**: Read platform-specific output format into pandas DataFrame.
2. **Filter**: Remove contaminants, reverse hits (MaxQuant), low-detection proteins.
3. **Transform**: Log2 intensities (skip for Olink NPX, already log2).
4. **Normalize**: VSN (DDA/DIA), median (DDA/DIA alternative), MSstatsTMT (TMT), bridge (Olink multi-plate). Do NOT normalize SomaScan if ANML already applied.
5. **Impute**: Assess missing value pattern (MNAR vs MAR). Apply appropriate imputation.
6. **Batch check**: PCA colored by batch/plate/plex. Correct if needed (ComBat or include as covariate).
7. **DE testing**: Apply method from decision tree. Extract results with log2FC, p-value, adjusted p-value.
8. **Downstream**: Pathway enrichment via decoupler, protein-protein interaction networks.

## Output Conventions

- Save processed protein matrix as CSV: rows = proteins (UniProt ID + gene symbol), columns = samples.
- DE results as CSV: protein, gene, log2FoldChange, pvalue, padj, avg_intensity.
- Volcano plot (log2FC vs -log10 padj) and intensity distribution boxplots as PNG/PDF.
- Missing value heatmap showing pattern (MNAR vs MAR assessment).
- PCA plot of samples colored by condition and batch/plate.
- Protein ID mapping table: UniProt accession to gene symbol.

## Anti-Patterns

- **Treating protein intensities like RNA-seq counts**: Protein intensities are continuous, not discrete counts. Do NOT use DESeq2/edgeR/PyDESeq2 on proteomics data. Use limma, DEP, or MSstats.
- **Ignoring missing value patterns**: MNAR (below detection limit) and MAR (random dropout) require different imputation strategies. Using kNN for MNAR or MinProb for MAR introduces systematic bias.
- **Not checking for batch effects in multi-plate studies**: Olink multi-plate, TMT multi-plex, and DDA multi-batch experiments all require explicit batch correction. Uncorrected batch effects dominate real biology.
- **Protein-level analysis on phosphoproteomics data**: Rolling up phospho-sites to protein level destroys site-specific regulation. A protein can have sites with opposite regulation (activating vs inhibiting phosphorylation).
- **Normalizing already-normalized data**: Olink NPX values are pre-normalized. SomaScan with ANML is pre-normalized. Double-normalization distorts the data.
- **Imputing before filtering**: Impute after removing low-quality proteins/samples. Imputing values for proteins with >50% missing is unreliable.
- **Using t-tests without multiple testing correction**: Always apply BH/FDR correction. With thousands of proteins, uncorrected p-values produce massive false positives.
- **Ignoring protein grouping**: MaxQuant groups proteins sharing peptides. Using individual protein IDs without resolving groups inflates the number of "hits" and introduces redundancy.

## Additional Available Packages

### Python

- **spectrum-utils**: Mass spectrometry spectrum visualization — annotated spectra, mirror plots for spectral library matching. Use for QC and figure generation.
- **ms-deisotope**: Deisotoping and charge state deconvolution. Use for preprocessing high-resolution MS1/MS2 spectra before database search.

### R (via rpy2)

- **MSnbase**: Legacy MS data class infrastructure. `readMSData()` for reading mzML. Foundation for xcms.
- **Spectra** (Bioconductor): Modern MS data backend replacing MSnbase. Use `Spectra()`, `filterMsLevel()`, `peaksData()`.

## References

API references for all supported packages:

- `references/dep-rpy2-api.md` — DEP for DDA/DIA proteomics (filtering, normalization, imputation, DE)
- `references/msstats-rpy2-api.md` — MSstats/MSstatsTMT for label-free and TMT proteomics
- `references/olink-somascan-api.md` — Olink NPX and SomaScan RFU preprocessing patterns
- `references/pyteomics-api.md` — Python toolkit for reading MS formats (mzML, pepXML)
