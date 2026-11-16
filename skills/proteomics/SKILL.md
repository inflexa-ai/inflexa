---
name: proteomics
description: Read before you analyze mass spectrometry or affinity proteomics data (label-free, isobaric labels, Olink, SomaScan) or phosphosites. It gives the preprocessing for each platform, the imputation for each pattern of missing values, the DE method, and which data is already normalized.
metadata:
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
├── Site context: put each regulated site on its protein
│   ├── Resource: the UniProt protein features of the human proteome — domains,
│   │   regions, active and binding sites, and known modified residues, keyed by
│   │   UniProt accession, as residue ranges on the canonical sequence
│   ├── Join on the accession, then find the ranges that hold the site position
│   │   (a site in the kinase domain, a site that UniProt already lists)
│   ├── Compare only a site numbered on the canonical accession. A site table can
│   │   number a site on an isoform of the protein group ('-N' suffix): report
│   │   such a site without context
│   └── If the resource is not in the reference inventory, report it and deliver
│       the sites without context
└── Critical: Do NOT roll up phospho-sites to protein level — this loses site-specific information
```

## Goal and Constraints

The goal is a DE table of the proteins or the sites, from a matrix that you normalized once.

- Remove the contaminants and the reverse hits of MaxQuant, and the proteins with low detection, before you impute.
- Do not log-transform Olink NPX. NPX is log2 already.
- Do not normalize SomaScan RFU after ANML, or Olink NPX within one plate. Both are normalized already.
- If the samples ran in more than one batch, plate, or plex, keep the batch as a covariate of the design, or correct it.

## Output Conventions

- Save processed protein matrix as CSV: rows = proteins (UniProt ID + gene symbol), columns = samples.
- DE results as CSV: protein, gene, log2FoldChange, pvalue, padj, avg_intensity.
- Protein ID mapping table: UniProt accession to gene symbol.

## Anti-Patterns

- **A kinase-substrate network from a fetcher**: No kinase-substrate network is in the reference inventory, and each `dc.op.*` fetcher uses the network. Deliver the site-level DE without kinase activity, and say why. Do not use a TF regulon in its place.
- **Site context on an isoform**: The UniProt protein features use the canonical sequence. Report a site on an isoform accession ('-N' suffix) without context.
- **Treating protein intensities like RNA-seq counts**: Protein intensities are continuous, not discrete counts. Do NOT use DESeq2/edgeR/PyDESeq2 on proteomics data. Use limma, DEP, or MSstats.
- **Normalizing already-normalized data**: Olink NPX values are pre-normalized. SomaScan with ANML is pre-normalized. Double-normalization distorts the data.
- **The wrong imputation for the missing-value pattern**: MNAR (below the detection limit) takes MinProb. MAR (random dropout) takes kNN. kNN on MNAR or MinProb on MAR gives a systematic bias.
- **Imputing before filtering**: Impute after you remove the low-quality proteins and samples. An imputation for a protein with > 50% missing values is not reliable.
- **No batch check in a multi-plate study**: Olink multi-plate, TMT multi-plex, and DDA multi-batch data need an explicit batch term or correction.
- **Tests without multiple testing correction**: Apply BH FDR. Thousands of proteins give many false positives on raw p-values.
- **Ignoring protein groups**: MaxQuant groups the proteins that share peptides. Single protein IDs without the groups inflate the number of hits.
- **Protein-level analysis of phosphosites**: A rollup to the protein destroys the site-specific regulation. One protein can carry sites with opposite regulation.

## References

API references for all supported packages:

- `references/dep-rpy2-api.md` — DEP for DDA/DIA proteomics (filtering, normalization, imputation, DE)
- `references/msstats-rpy2-api.md` — MSstats/MSstatsTMT for label-free and TMT proteomics
- `references/olink-somascan-api.md` — Olink NPX and SomaScan RFU preprocessing patterns
- `references/pyteomics-api.md` — Python toolkit for reading MS formats (mzML, pepXML)
