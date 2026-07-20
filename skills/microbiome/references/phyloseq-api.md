# phyloseq API Reference

Central data structure for microbiome analysis in R: stores OTU/ASV tables, taxonomy, sample metadata, and phylogenetic trees in a single object.

**Filenames below are placeholders.** `feature-table.biom`, `tree.nwk`, `rep-seqs.fasta` and the like stand for your step's inputs — either files you produced upstream (relative to your working directory) or input data reached by absolute path beneath the read-only analysis root. Do not assume a directory layout; use the paths you were given.

## Setup

```r
library(phyloseq)
library(vegan)
library(ggplot2)
```

## phyloseq() Constructor

Build a phyloseq object from individual components. All components are optional except the OTU table.

```r
# otu_mat: taxa as rows, samples as columns (integer counts)
# tax_mat: taxa as rows, rank columns (Kingdom, Phylum, Class, Order, Family, Genus, Species)
# meta_df: samples as rows, metadata columns

otu <- otu_table(otu_mat, taxa_are_rows = TRUE)
tax <- tax_table(tax_mat)
samp <- sample_data(meta_df)

# Assemble (include only components you have)
ps <- phyloseq(otu, tax, samp)

# With a phylogenetic tree
library(ape)
tree <- read.tree("tree.nwk")
ps <- phyloseq(otu, tax, samp, tree)
```

## import_biom()

Import BIOM-format files (from QIIME2 or other pipelines).

```r
# BIOM v1 (JSON) or v2 (HDF5)
ps <- import_biom("feature-table.biom")

# BIOM + tree + refseq
ps <- import_biom(
  "feature-table.biom",
  treefilename = "tree.nwk",
  refseqfilename = "rep-seqs.fasta"
)

# Add sample metadata after import
sample_data(ps) <- sample_data(meta_df)
```

## Taxonomic Agglomeration: tax_glom()

Merge taxa at a given taxonomic rank.

```r
# Agglomerate at genus level
ps_genus <- tax_glom(ps, taxrank = "Genus")

# Agglomerate at phylum level
ps_phylum <- tax_glom(ps, taxrank = "Phylum")

# NArm = FALSE keeps taxa with NA at the target rank
ps_genus <- tax_glom(ps, taxrank = "Genus", NArm = FALSE)
```

## Pruning: prune_taxa() and prune_samples()

```r
# Keep only taxa present in at least 10% of samples
prev <- apply(otu_table(ps), 1, function(x) sum(x > 0) / length(x))
ps_filt <- prune_taxa(prev > 0.10, ps)

# Keep specific taxa by name
ps_sub <- prune_taxa(c("ASV1", "ASV2", "ASV3"), ps)

# Prune samples by minimum read count
ps_filt <- prune_samples(sample_sums(ps) >= 1000, ps)

# Subset by metadata
ps_sub <- subset_samples(ps, group == "treatment")
```

## Relative Abundance Transform

```r
ps_rel <- transform_sample_counts(ps, function(x) x / sum(x))
```

## Ordination: ordinate()

```r
# PCoA on Bray-Curtis distances
ord_pcoa <- ordinate(ps, method = "PCoA", distance = "bray")

# NMDS on Bray-Curtis
ord_nmds <- ordinate(ps, method = "NMDS", distance = "bray")

# PCoA on UniFrac (requires phylogenetic tree in ps)
ord_unifrac <- ordinate(ps, method = "PCoA", distance = "unifrac")
ord_wunifrac <- ordinate(ps, method = "PCoA", distance = "wunifrac")

# Extract ordination coordinates
coords <- ord_pcoa$vectors[, 1:2]
```

### ordinate() Parameters

```r
ordinate(
  ps,                 # phyloseq object
  method = "PCoA",    # "PCoA"|"NMDS"|"DCA"|"CCA"|"RDA"|"DPCoA"|"MDS"
  distance = "bray"   # "bray"|"jaccard"|"unifrac"|"wunifrac"|"jsd"|"euclidean"
)
```

## Alpha Diversity: estimate_richness()

```r
# Calculate multiple alpha diversity metrics
alpha <- estimate_richness(ps)
# Columns: Observed, Chao1, se.chao1, ACE, se.ACE, Shannon, Simpson, InvSimpson, Fisher

# Specific measures only
alpha <- estimate_richness(ps, measures = c("Shannon", "Simpson", "Chao1"))
```

## Distance Matrices

```r
# Compute distance matrix directly
dm <- distance(ps, method = "bray")

# Convert to matrix for inspection
dm_mat <- as.matrix(dm)
```

## PERMANOVA (via vegan)

```r
# Extract distance matrix and metadata
dm <- distance(ps, method = "bray")
meta <- as(sample_data(ps), "data.frame")

# Basic PERMANOVA
result <- adonis2(dm ~ group, data = meta, permutations = 999)
# result$R2, result$`Pr(>F)`

# With covariates
result <- adonis2(dm ~ group + age + sex, data = meta, permutations = 999)

# Check dispersion homogeneity (PERMANOVA assumption)
bd <- betadisper(dm, meta$group)
permutest(bd, permutations = 999)
```

## Bar Plots: plot_bar()

```r
# Relative abundance bar plot by phylum
p <- plot_bar(ps_rel, fill = "Phylum") +
  facet_wrap(~group, scales = "free_x") +
  theme_minimal()
ggsave("barplot.png", p, width = 10, height = 6, dpi = 300)
ggsave("barplot.pdf", p, width = 10, height = 6)
```

## Saving Results for Downstream Steps

```r
# Export OTU table as CSV
otu_df <- as.data.frame(otu_table(ps))
write.csv(otu_df, "output/otu_table.csv")

# Export taxonomy as CSV
tax_df <- as.data.frame(tax_table(ps))
write.csv(tax_df, "output/taxonomy.csv")

# Export alpha diversity as CSV
alpha_df <- estimate_richness(ps, measures = c("Shannon", "Simpson", "Chao1"))
alpha_df$sample_id <- rownames(alpha_df)
write.csv(alpha_df, "output/alpha_diversity.csv", row.names = FALSE)

# Export ordination coordinates as CSV
coords <- as.data.frame(ord_pcoa$vectors[, 1:2])
coords$sample_id <- rownames(coords)
write.csv(coords, "output/pcoa_coordinates.csv", row.names = FALSE)
```

## Gotchas

- `taxa_are_rows = TRUE` is critical when constructing `otu_table()`. If your OTU matrix has samples as rows, set `taxa_are_rows = FALSE`.
- `tax_glom()` silently drops taxa with NA at the target rank unless `NArm = FALSE`.
- `import_biom()` reads BIOM v1 (JSON) natively. For BIOM v2 (HDF5), the `biomformat` R package must be installed.
- `estimate_richness()` expects raw counts, not relative abundance. Run it before `transform_sample_counts()`.
- UniFrac distances require a phylogenetic tree in the phyloseq object. If missing, you get a cryptic error about `phy_tree`.
- Memory: large OTU tables (>50k taxa) can exhaust R memory. Filter low-abundance taxa first.
- `ordinate()` with NMDS may not converge. Check `ord_nmds$stress` — values >0.2 indicate poor fit.
- `adonis2()` (vegan) uses a formula interface. Always run `betadisper()` alongside — a significant PERMANOVA with unequal dispersions may reflect dispersion differences, not centroid shifts.
