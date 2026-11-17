---
name: microbiome
description: Read before you analyze amplicon or shotgun microbiome data (ASVs, taxonomy, diversity, differential abundance). The data is compositional, thus usual tests and RNA-seq methods give false results. It gives the correct method for each design and the rules for rarefaction and zeros.
metadata:
  version: 1.0.0
  tags: [microbiome, 16s, its, shotgun, metagenomics, compositional, ancombc, aldex2]
  category: genomics
---

# Microbiome Analysis

Comprehensive guidelines for amplicon and shotgun metagenomics, with emphasis on compositional data analysis, diversity metrics, differential abundance, and functional profiling.

## Compositionality

Microbiome counts are compositional. Use a compositional-aware method for each statistical test. Do not use a t-test, a Wilcoxon test, a correlation, DESeq2, or edgeR on the counts or the proportions.

## Method-Selection Decision Tree

### 1. 16S/ITS Amplicon Sequencing

```
Demultiplexed FASTQ
  → DADA2 (R): filterAndTrim → learnErrors → dada → mergePairs → makeSequenceTable → removeBimeraDenovo
    → ASV table + taxonomy assignment (assignTaxonomy with SILVA for 16S, UNITE for ITS)
      → Import into phyloseq (R) for downstream analysis

Alternative: QIIME2 artifacts
  → Import pre-processed QIIME2 feature table + taxonomy
    → Convert to phyloseq for R-based analysis or pandas DataFrame for Python
```

- **DADA2 is installed**, so raw demultiplexed FASTQ is a supported entry point: the chain above runs end to end through `removeBimeraDenovo` and yields an ASV table, the ASV sequences, and per-step read tracking. Taxonomy assignment is the one step that may not complete — it needs a training set, which is a separate question covered below. QIIME2 is **not** installed, so that branch is import-only: bring an exported feature table rather than expecting a `.qza` to be read natively. A pre-computed feature table (BIOM, QIIME2 export, or counts matrix plus taxonomy) is still a perfectly good entry point when that is what you were handed — the rest of this pack (phyloseq, vegan, mia, ANCOM-BC2, ALDEx2, MaAsLin2, biom-format, scikit-bio) runs from it normally.
- **SILVA (16S/18S) and UNITE (ITS) training sets are opt-in downloads in the reference inventory.** Resolve the set and its release before you plan the taxonomy step. Do not assume a version.

### 2. Shotgun Metagenomics

```
Taxonomic abundance table (species-level relative abundances)
  → Import into phyloseq or pandas
    → Diversity and differential-abundance sections below

Functional abundance table (gene families / pathway abundances)
  → Import into pandas
    → Differential pathway analysis below
```

- **Entry point is a profiled table, not reads.** Taxonomic and functional profiling of shotgun FASTQ happens upstream; expect to be handed its output. If you were given raw shotgun reads, say so and stop.
- Profiler output is relative abundance, so it is compositional — carry that through to the differential methods rather than treating it as counts.

### 3. Alpha Diversity

```
Feature table (ASV or species counts)
  → Richness: Chao1 (estimated richness, accounts for unseen species)
  → Evenness + richness: Shannon index (sensitive to rare taxa), Simpson index (weighted toward dominant taxa)
  → Phylogenetic: Faith's PD (incorporates phylogenetic tree, requires rooted tree)
    → Compute via phyloseq estimate_richness() (R)
      → Statistical comparison: Kruskal-Wallis (>2 groups), Wilcoxon (2 groups)
```


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


### 6. Functional Profiling

```
Functional abundance table (gene families + pathway abundances)
  → Normalize: copies per million (CPM)
    → Differential pathway analysis: same compositional-aware methods as taxonomic data
```

- Functional profiles arrive already compositional (relative abundance). Use the same differential methods as for taxonomic data.
- If a functional table was inferred from 16S rather than measured from shotgun reads, it is a prediction — say so in the output and do not present it alongside measured abundances without that distinction.

### 7. Rarefaction

```
Should I rarefy?
  → Prefer NOT to rarefy. Modern methods (ANCOM-BC2, ALDEx2, MaAsLin2) handle unequal library sizes internally.
  → If required for legacy compatibility or specific diversity metrics:
    → Rarefy to the minimum library size (or exclude low-depth samples)
    → NEVER rarefy for differential abundance testing — it discards valid data.
```


## Anti-Patterns

- **SparCC or `propr` for a compositional correlation**: Neither is installed. CLR-transform the counts (log of each value over the geometric mean of the sample, after a pseudocount or zero replacement). Then take the correlation of the CLR values, or compute rho proportionality as `1 - var(clr_i - clr_j) / (var(clr_i) + var(clr_j))` in numpy. State which measure you used.
- **A native read of a QIIME2 `.qza`**: QIIME2 is not installed. Ask for the exported feature table.
- **Taxonomy without a resolved training set**: The SILVA and UNITE training sets are opt-in downloads. If they are absent, report that taxonomy assignment cannot run and that the sets can be provisioned. Deliver the ASV table, the sequences, and the read tracking. Do not use a different sequence database.
- **Ignoring taxonomy assignment confidence**: Do NOT report taxa assigned with low bootstrap confidence (<70%).
- **t-test or Wilcoxon on proportions**: A taxon can look different only because another taxon changed. Use ANCOM-BC2, ALDEx2, or MaAsLin2.
- **Pearson or Spearman on relative abundances**: Compositional data gives spurious negative correlations. Use the CLR measure above.
- **DESeq2 on microbiome counts**: The data is zero-inflated and compositional, and DESeq2 has elevated false positive rates on it (Nearing et al. 2022, Calgaro et al. 2020).
- **Rarefaction before differential abundance**: It discards valid data. The compositional methods handle the library sizes.
- **Rarefaction at one depth for alpha diversity**: Do it again at more than one depth, and report the rarefaction curves.
- **No check of the DADA2 error model**: Inspect the error rate plots of `learnErrors`. A poor error model gives unreliable ASVs.
- **Averaging relative abundances of technical replicates**: Sum the raw counts first. Then compute the relative abundances.
- **Zeros as true absence**: Structural and sampling zeros both occur. Do not filter low-prevalence taxa too aggressively: a taxon in 10% of the samples of one group can be meaningful.

## Output Conventions

- Feature tables: BIOM format or AnnData (.h5ad) with taxa as `var`, samples as `obs`, counts as `X`.
- Taxonomy tables: CSV with `feature_id`, `kingdom`, `phylum`, `class`, `order`, `family`, `genus`, `species`, `confidence`.
- Differential results: CSV with `taxon`, `log2FC`, `se`, `pvalue`, `padj`, `method` (ANCOM-BC2/ALDEx2/MaAsLin2).
- Diversity results: CSV with `sample_id`, `shannon`, `simpson`, `chao1`, `faiths_pd`.
- Use biom-format package for BIOM file I/O in Python, phyloseq for R-based operations.

## Additional Available Packages

- **vegan** (R): `adonis2()` is the reason to reach for it — PERMANOVA with a formula interface, so a community difference can be tested while adjusting for covariates rather than as a single-factor comparison. Also `betadisper()`, whose dispersion test says whether a significant PERMANOVA reflects a location shift or unequal spread.

## References

- `references/dada2-api.md` — DADA2 amplicon sequence variant inference (16S/ITS pipeline)
- `references/phyloseq-api.md` — Phyloseq object creation, manipulation, and diversity
- `references/vegan-api.md` — vegan: beta diversity (vegdist), NMDS (metaMDS), PERMANOVA (adonis2), dispersion (betadisper)
- `references/ancombc-api.md` — ANCOM-BC2 compositional differential abundance
- `references/aldex2-api.md` — ALDEx2 CLR-based differential abundance
- `references/maaslin2-api.md` — MaAsLin2 longitudinal differential abundance
- `references/biom-format-api.md` — BIOM file parsing and conversion (Python)
