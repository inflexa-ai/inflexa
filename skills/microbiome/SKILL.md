---
name: microbiome
description: Microbiome analysis — compositional data handling, 16S/ITS amplicon, shotgun metagenomics, diversity, differential abundance, and functional profiling
version: 1.0.0
tags: [microbiome, 16s, its, shotgun, metagenomics, compositional, ancombc, aldex2]
---

# Microbiome Analysis

Comprehensive guidelines for amplicon and shotgun metagenomics, with emphasis on compositional data analysis, diversity metrics, differential abundance, and functional profiling.

## COMPOSITIONALITY WARNING — READ FIRST

**Microbiome count data is compositional.** Sequencing produces counts that sum to a constant (library size). Each sample's counts represent relative proportions, NOT absolute abundances. This has profound statistical consequences:

- An increase in one taxon's proportion **forces** decreases in others, even if their absolute abundance is unchanged.
- Standard statistical tests (t-test, Wilcoxon, correlation) on raw counts or proportions produce **spurious correlations** and **false positives**.
- Methods designed for gene expression (DESeq2, edgeR) assume count distributions that do NOT hold for compositional, zero-inflated microbiome data.

**You MUST use compositional-aware methods for all statistical analyses.** This is not optional — it is a fundamental requirement of the data type. See the Differential Abundance section below for approved methods.

## Method-Selection Decision Tree

### 1. 16S/ITS Amplicon Sequencing

```
Demultiplexed FASTQ
  → DADA2 (R): filterAndTrim → learnErrors → dada → mergePairs → makeSequenceTable → removeBimeraDenovo
    → ASV table + taxonomy assignment (assignTaxonomy with SILVA 138.1 for 16S, UNITE for ITS)
      → Import into phyloseq (R) for downstream analysis

Alternative: QIIME2 artifacts
  → Import pre-processed QIIME2 feature table + taxonomy
    → Convert to phyloseq for R-based analysis or pandas DataFrame for Python
```

- DADA2 produces ASVs (amplicon sequence variants) — single-nucleotide resolution, no OTU clustering needed.
- ALWAYS inspect the error rate learning plots. Poor error models produce unreliable ASVs.
- SILVA 138.1 is the standard reference for 16S; UNITE for ITS (fungal).
- **SILVA and UNITE training sets are not currently in the reference inventory.** Resolve them by what they are before planning on them. If they are absent, report that taxonomy assignment cannot be run and hand back the ASV table, sequences, and read tracking — which are complete and useful without it. Do not invent a path, do not substitute a general-purpose sequence database, and do not drop the taxonomy step silently.

### 2. Shotgun Metagenomics

```
FASTQ (host-decontaminated, QC'd)
  → Taxonomic profiling: MetaPhlAn 4
    → Species-level relative abundances (marker gene-based)
  → Functional profiling: HUMAnN 3
    → Gene family and pathway abundances (UniRef + MetaCyc)
      → Import into phyloseq or pandas for downstream analysis
```

- MetaPhlAn 4 is the preferred taxonomic profiler. It uses clade-specific markers, not read mapping to full genomes.
- HUMAnN 3 provides pathway-level functional profiles. Use stratified output to see per-species contributions.

### 3. Alpha Diversity

```
Feature table (ASV or species counts)
  → Richness: Chao1 (estimated richness, accounts for unseen species)
  → Evenness + richness: Shannon index (sensitive to rare taxa), Simpson index (weighted toward dominant taxa)
  → Phylogenetic: Faith's PD (incorporates phylogenetic tree, requires rooted tree)
    → Compute via phyloseq estimate_richness() (R)
      → Statistical comparison: Kruskal-Wallis (>2 groups), Wilcoxon (2 groups)
```

- Report multiple diversity metrics — they capture different aspects of community structure.
- Shannon is most commonly reported. Faith's PD adds phylogenetic perspective when a tree is available.

### 4. Beta Diversity

```
Feature table
  → Distance matrix:
    → Bray-Curtis (abundance-weighted, default)
    → Jaccard (presence/absence only)
    → UniFrac (weighted or unweighted, requires phylogenetic tree)
      → Ordination: PCoA (default) or NMDS (when PCoA stress is high)
        → Statistical testing: PERMANOVA (adonis2 in vegan)
          → Check dispersion: betadisper (PERMANOVA is sensitive to heterogeneous dispersion)
```

- Bray-Curtis is the default distance metric. Use UniFrac when phylogenetic relationships matter.
- ALWAYS run betadisper alongside PERMANOVA. A significant PERMANOVA with unequal dispersions may reflect dispersion differences, not centroid shifts.
- Use phyloseq `distance()` + `ordinate()` for distance computation and ordination. Use vegan `adonis2()` for PERMANOVA (supports formula interface with covariates) and `betadisper()` for dispersion testing.

### 5. Differential Abundance

**All methods below are compositional-aware. Do NOT substitute with t-test, Wilcoxon, DESeq2, or edgeR.**

```
Cross-sectional study (no repeated measures)
  → ANCOM-BC2 (R) — DEFAULT CHOICE
    → Bias-corrected log-linear model, handles compositionality natively
    → ancombc2() with formula, handles covariates
    → Structural zero detection built-in

Small sample size (n < 10 per group)
  → ALDEx2 (R)
    → CLR transformation + Bayesian Monte Carlo sampling
    → Robust to small samples due to posterior inference
    → aldex() → aldex.ttest() or aldex.kw()

Longitudinal / repeated measures / complex covariates
  → MaAsLin2 (R)
    → Supports random effects for subject-level correlation
    → Maaslin2() with fixed_effects + random_effects
    → CLR or log-transformed relative abundances internally
```

- ANCOM-BC2 is the default. It corrects for the compositional bias term explicitly.
- ALDEx2 is preferred for small studies because its Bayesian approach models technical variation.
- MaAsLin2 is the only option that handles random effects for longitudinal designs.

### 6. Functional Profiling

```
Shotgun metagenomics data
  → HUMAnN 3: gene families (UniRef90) + pathway abundances (MetaCyc)
    → Regroup to KO, EC, or Pfam with humann_regroup_table
    → Normalize: copies per million (CPM)
      → Differential pathway analysis: same compositional-aware methods as taxonomic data

16S amplicon data (no shotgun available)
  → PICRUSt2 (predicted metagenome from 16S)
    → Infer gene content from reference genomes of detected taxa
    → Lower confidence than direct shotgun — flag as "predicted"
```

- HUMAnN 3 output is already compositional (relative abundance). Use the same differential methods.
- PICRUSt2 predictions are only as good as the reference genome database. Report NSTI scores as quality metric.

### 7. Rarefaction

```
Should I rarefy?
  → Prefer NOT to rarefy. Modern methods (ANCOM-BC2, ALDEx2, MaAsLin2) handle unequal library sizes internally.
  → If required for legacy compatibility or specific diversity metrics:
    → Rarefy to the minimum library size (or exclude low-depth samples)
    → NEVER rarefy for differential abundance testing — it discards valid data.
```

- Rarefaction is controversial and increasingly discouraged. ANCOM-BC2 and ALDEx2 handle library size differences without data loss.
- If rarefaction is used for alpha diversity, repeat at multiple depths and report rarefaction curves.

## Anti-Patterns

- **t-test/Wilcoxon on proportions**: INVALID. Relative abundances are compositional — standard tests produce spurious results. A taxon can appear "significantly different" purely because another taxon changed. Use ANCOM-BC2, ALDEx2, or MaAsLin2.
- **Standard correlation on relative abundances**: SPURIOUS. Pearson/Spearman correlation on compositional data produces negative bias (spurious negative correlations). Use SparCC or proportionality (propr package) for compositional correlation.
- **DESeq2 on microbiome counts**: INAPPROPRIATE. DESeq2 assumes a negative binomial distribution calibrated for RNA-seq count data. Microbiome data is zero-inflated and compositional — DESeq2 has elevated false positive rates on microbiome data (Nearing et al. 2022, Calgaro et al. 2020).
- **Rarefaction for differential abundance**: WASTEFUL. Rarefying discards valid sequencing data to equalize library sizes. Modern compositional methods (ANCOM-BC2) handle library size differences properly. Do NOT rarefy before differential testing.
- **Ignoring taxonomy assignment confidence**: Do NOT report taxa assigned with low bootstrap confidence (<70%). Unreliable assignments propagate errors through all downstream analyses.
- **Pooling technical replicates incorrectly**: Do NOT average relative abundances across technical replicates. Sum the raw counts first, then compute relative abundances.
- **Treating zeros as true absence**: Microbiome data contains both structural zeros (true absence) and sampling zeros (present but undetected). Do NOT filter low-prevalence taxa too aggressively — a taxon present in 10% of samples in one group may be biologically meaningful.

## Output Conventions

- Feature tables: BIOM format or AnnData (.h5ad) with taxa as `var`, samples as `obs`, counts as `X`.
- Taxonomy tables: CSV with `feature_id`, `kingdom`, `phylum`, `class`, `order`, `family`, `genus`, `species`, `confidence`.
- Differential results: CSV with `taxon`, `log2FC`, `se`, `pvalue`, `padj`, `method` (ANCOM-BC2/ALDEx2/MaAsLin2).
- Diversity results: CSV with `sample_id`, `shannon`, `simpson`, `chao1`, `faiths_pd`.
- Figures: stacked bar plots (relative abundance), PCoA/NMDS ordination plots, alpha diversity box plots, differential abundance forest plots, rarefaction curves.
- Use biom-format package for BIOM file I/O in Python, phyloseq for R-based operations.

## Additional Available Packages

- **vegan** (R): Ecological community analysis — `adonis2()` for PERMANOVA (formula interface with covariates), `diversity()` for alpha diversity, `vegdist()` for distance matrices, `metaMDS()` for NMDS ordination, `betadisper()` for dispersion testing.
- **mia / miaViz** (R): TreeSummarizedExperiment-based microbiome analysis framework. Alternative to phyloseq using Bioconductor infrastructure. Use when working with TreeSE objects.

### CLI Tools

- **kraken2 + bracken**: Taxonomic classification for shotgun metagenomics data. Use kraken2 for read classification, bracken for abundance re-estimation at species/genus level.
- **kneaddata**: Host decontamination and quality control for shotgun metagenomics FASTQ files. Run before taxonomic/functional profiling.
- **sra-tools**: NOT available — sandbox has no network access. Data must be pre-downloaded and provided as input files.

## References

- `references/dada2-api.md` — DADA2 amplicon sequence variant inference (16S/ITS pipeline)
- `references/phyloseq-api.md` — Phyloseq object creation, manipulation, and diversity
- `references/vegan-api.md` — vegan: beta diversity (vegdist), NMDS (metaMDS), PERMANOVA (adonis2), dispersion (betadisper)
- `references/ancombc-api.md` — ANCOM-BC2 compositional differential abundance
- `references/aldex2-api.md` — ALDEx2 CLR-based differential abundance
- `references/maaslin2-api.md` — MaAsLin2 longitudinal differential abundance
- `references/biom-format-api.md` — BIOM file parsing and conversion (Python)
