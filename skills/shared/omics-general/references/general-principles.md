# General Principles

## 1. Data Format: AnnData / MuData as Universal Containers

All pipelines should aim to convert raw or processed inputs into **AnnData** (single-modality)
or **MuData** (multi-modality) as early as possible. This ensures:

- A consistent in-memory and on-disk format (`.h5ad` / `.h5mu`)
- Seamless interoperability with the scanpy / muon / squidpy / decoupler ecosystem
- Metadata (obs, var, obsm, obsp, uns) travels with the data

When working with R-native formats (e.g., SummarizedExperiment, SingleCellExperiment,
Seurat), convert to AnnData via `anndata` R package or rpy2 bridges as soon as initial
processing (if R-dependent) is complete.

## 2. Language Preference: Python-First, R When Appropriate

- **Python is the default.** Use scanpy, muon, squidpy, decoupler, PyDESeq2, etc.
- **R is used when** a Python equivalent does not exist or is clearly inferior.
  Common R-only scenarios: microarray analysis (limma), methylation arrays (minfi,
  ChAMP), microbiome (DADA2, phyloseq, ANCOM-BC2), metabolomics preprocessing (XCMS).
- **Choose native R or rpy2 based on the scope of R usage:**
  - **Isolated R calls** in an otherwise Python pipeline → use rpy2 bridge (e.g.,
    calling DESeq2 for one DE step, fgsea for enrichment).
  - **R-dominant pipeline** where most steps use R packages → write native R scripts
    (e.g., microbiome, methylation arrays, untargeted metabolomics).

## 3. Analysis Plan Structure

When designing an analysis plan, always address these phases:

1. **Data ingestion & QC** — file parsing, format conversion, quality metrics
2. **Preprocessing** — normalization, filtering, batch correction
3. **Core analysis** — the primary analytical methods (DE, clustering, etc.)
4. **Downstream / functional interpretation** — pathway enrichment, regulatory inference
5. **Visualization & reporting** — publication-quality figures, summary tables

## 4. Reproducibility

- Pin package versions in environment files
- Use deterministic seeds where stochastic methods are involved
- Log all parameters and thresholds

---

## Cross-Cutting Analysis Types

Several analysis types appear across multiple omics. Here are the general preferences:

### Differential Analysis
- Bulk count data (RNA-seq, ATAC-seq peaks): **PyDESeq2** (Python) or DESeq2 via rpy2
- Microarray: **limma** via rpy2 (no good Python alternative)
- Single-cell: **pseudobulk + PyDESeq2** (recommended over per-cell tests for most designs)
- Proteomics intensity: **limma** via rpy2 or PyDESeq2 depending on data distribution

#### Longitudinal / Repeated Measures Designs
When samples include repeated measurements from the same subject (e.g., pre/post treatment,
time-series, paired tissues), standard DE methods that assume independent observations are
inappropriate. Use **mixed models** with a random effect for subject to account for the
within-subject correlation structure.

- **dream** (R via rpy2, part of **variancePartition** package): the preferred tool for
  repeated-measures DE across most omics types. Combines voom observational weights with
  lme4 linear mixed models, producing moderated t-statistics. Works for both count data
  (RNA-seq, ATAC-seq) and continuous intensity data (proteomics, metabolomics).
  Formula example: `~ condition + (1|subject)`
- **limma::duplicateCorrelation()** (R via rpy2): simpler alternative for balanced designs
  with a single blocking factor. Estimates the within-block correlation and incorporates
  it into the limma linear model. Less flexible than dream but faster.
- **statsmodels MixedLM** (Python): for continuous data (proteomics, metabolomics) when
  staying in Python is preferred. Less omics-specific than dream but functional.
- **Metagenomics**: **MaAsLin2** natively supports random effects — use it directly for
  longitudinal microbiome designs.

General rule: if the experiment has repeated measures, use dream (R via rpy2) unless a
modality-specific tool already handles random effects (e.g., MaAsLin2 for metagenomics).

### Gene Set / Pathway Enrichment
- Over-representation analysis (ORA): **decoupler** with gene sets from the reference store or custom sets
- Gene Set Enrichment Analysis (GSEA): **decoupler** (implements fast, run-based methods)
- Pathway activity scoring: **decoupler** with a footprint-based pathway weight matrix (e.g. PROGENy)
- Query the reference store for what gene set collections are actually installed rather than
  assuming a particular one. Collections are typically distributed as `.gmt`, which is
  **ragged** and must be parsed line-by-line — not with `pandas.read_csv`. Pathway weight
  matrices may be R `.rda` objects, which require rpy2 (or native R), not a pandas reader.

### Transcription Factor Activity Inference
- **decoupler** with a curated TF-target regulon network as the prior
- Query the reference store for the regulon networks that are installed and read the
  entry's stated format and columns. A CSV regulon loads with pandas; an R `.rda` regulon
  must be loaded through rpy2. Rename the TF/target/effect columns to
  `source`/`target`/`weight` for decoupler, and apply any confidence filter the network
  documents before use.
- If no regulon network is installed, report that TF-activity inference cannot be run
  rather than substituting a hand-written gene list.

### Cell-Cell Communication (single-cell / spatial)
- **LIANA+** — meta-framework that wraps and benchmarks multiple CCC methods
- Provides consensus scoring across CellPhoneDB, NATMI, SingleCellSignalR, etc.

### Gene Regulatory Network Inference
- **pySCENIC** — co-expression (GRNBoost2) then motif pruning (cisTarget). The pruning
  step is what separates a regulon from a co-expression module, and it reads reference
  data that is an opt-in download: resolve it first, and if it is absent say so rather
  than reporting unpruned modules as regulons.
- **decoupler** with a TF-target regulon resource, when the goal is scoring known
  regulon activity rather than discovering regulons. Much cheaper, and its reference
  data is a small download rather than a large one.
- SCENIC+ and CellOracle are **not available here** and should not be planned for.
  Neither installs in this environment, and SCENIC+ is additionally licensed for
  non-commercial academic use only. For RNA+ATAC or perturbation questions, state the
  limitation rather than substituting a tool that cannot run.

### Trajectory / Pseudotime Inference
- **scVelo** for RNA velocity (when spliced/unspliced info is available)
- **CellRank** for fate probability and driver gene identification
- **diffusion pseudotime** via scanpy for simpler trajectory models
- **Palantir** for probabilistic pseudotime in differentiation systems

### Dimensionality Reduction & Clustering
- PCA → neighborhood graph → UMAP/t-SNE (scanpy standard workflow)
- Clustering: **Leiden** (preferred over Louvain — better modularity optimization)
- For large datasets: approximate methods via scanpy's `use_rep` and RAPIDS-cuML

### Batch Correction / Integration
- **scVI** (scvi-tools) — deep generative model; best for complex batch structures
- **Harmony** (harmonypy) — fast, linear; good for moderate batch effects
- **scANVI** — when cell-type labels are partially available
- For bulk data: **ComBat** (via scanpy or pyCombat)
