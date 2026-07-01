# vegan API Reference

Community ecology toolkit for beta diversity analysis in R. Provides distance matrix computation (`vegdist`), ordination (`metaMDS`), PERMANOVA (`adonis2`), and multivariate dispersion testing (`betadisper`).

## Setup

```r
library(vegan)
```

## vegdist() — Dissimilarity / Distance Matrices

Computes pairwise dissimilarity between samples from a community matrix. Returns a `dist` object.

```r
dm <- vegdist(
  x,                    # matrix or data.frame — samples as rows, taxa as columns (abundances)
  method = "bray",      # character — dissimilarity index (see table below)
  binary = FALSE,       # logical — convert to presence/absence before computing
  diag = FALSE,         # logical — include diagonal in output
  upper = FALSE,        # logical — include upper triangle in output
  na.rm = FALSE         # logical — remove NAs pairwise
)
```

### Available Distance Methods

| Method | `method =` | Description |
|--------|------------|-------------|
| Bray-Curtis | `"bray"` | Default. Abundance-weighted. Range [0, 1]. Most widely used in microbiome. |
| Jaccard | `"jaccard"` | Presence/absence (set `binary = TRUE` for classic Jaccard). |
| Euclidean | `"euclidean"` | Standard Euclidean. Use on CLR-transformed data for Aitchison distance. |
| Aitchison | `"robust.aitchison"` | Robust CLR internally. Handles zeros. Compositionally appropriate. |
| UniFrac | — | Not in vegan. Use `phyloseq::distance(ps, "unifrac")` instead. |
| Gower | `"gower"` | Mixed data types. Excludes double-zeros. |
| Mountford | `"mountford"` | Presence/absence. Handles unknown sample sizes. |
| Horn-Morisita | `"horn"` | Abundance-weighted. Robust to sample size differences. |
| Cao | `"cao"` | Designed for data with many rare species. |
| Chao | `"chao"` | Handles unseen shared species. Good for undersampled data. |
| Raup-Crick | `"raup"` | Probabilistic presence/absence. |
| Kulczynski | `"kulczynski"` | Abundance-weighted. Good for detecting gradients. |
| Morisita | `"morisita"` | Abundance-weighted. Sensitive to dominant species. |
| Binomial | `"binomial"` | Based on binomial deviance. |
| Manhattan | `"manhattan"` | Sum of absolute differences. |
| Canberra | `"canberra"` | Weighted Manhattan. Sensitive to rare taxa. |

### vegdist() Usage Examples

```r
# Standard Bray-Curtis (default for microbiome beta diversity)
dm_bray <- vegdist(otu_mat)

# Jaccard on presence/absence
dm_jaccard <- vegdist(otu_mat, method = "jaccard", binary = TRUE)

# Aitchison distance (compositionally appropriate)
dm_aitchison <- vegdist(otu_mat, method = "robust.aitchison")

# Aitchison via manual CLR + Euclidean (equivalent)
dm_aitchison2 <- vegdist(decostand(otu_mat, "rclr"), method = "euclidean")

# Convert to matrix for inspection
dm_mat <- as.matrix(dm_bray)
```

## metaMDS() — Non-Metric Multidimensional Scaling (NMDS)

Performs NMDS with automatic data standardization, multiple random starts, and solution rotation. The recommended NMDS implementation in R.

```r
nmds <- metaMDS(
  comm,                  # matrix/data.frame — community data (samples x taxa), or a dist object
  distance = "bray",     # character — dissimilarity index (passed to vegdist if comm is not dist)
  k = 2,                 # int — number of dimensions
  try = 20,              # int — minimum number of random starts
  trymax = 20,           # int — maximum number of random starts
  autotransform = TRUE,  # logical — auto Wisconsin double + sqrt if needed
  noshare = TRUE,        # logical — use flexible shortest path adjustment
  wascores = TRUE,       # logical — compute weighted average scores for species
  expand = TRUE,         # logical — expand weighted average scores
  trace = 1,             # int — verbosity (0 = silent, 1 = dots, 2 = full)
  previous.best = NULL,  # metaMDS result — use as starting configuration
  maxit = 200,           # int — max iterations per run
  parallel = getOption("mc.cores"),  # int — parallel random starts
  ...                    # additional args passed to monoMDS
)
```

### metaMDS() Key Return Values

```r
nmds$stress       # numeric — stress value (goodness of fit, lower is better)
nmds$points       # matrix — sample ordination coordinates (n_samples x k)
nmds$species      # matrix — species scores (n_taxa x k), or NULL
nmds$converged    # logical — did the solution converge?
nmds$tries        # int — number of random starts attempted
nmds$distance     # character — distance method used
```

### Stress Interpretation

| Stress | Interpretation |
|--------|---------------|
| < 0.05 | Excellent representation |
| 0.05 - 0.10 | Good representation |
| 0.10 - 0.20 | Acceptable (usable with caution) |
| > 0.20 | Poor — suspect the ordination, consider more dimensions |

### NMDS Usage Examples

```r
# Standard NMDS on Bray-Curtis (microbiome default)
nmds <- metaMDS(otu_mat, distance = "bray", k = 2, trymax = 100, trace = 0)
cat("Stress:", nmds$stress, "\n")

# Extract sample coordinates
coords <- as.data.frame(nmds$points)
colnames(coords) <- c("NMDS1", "NMDS2")
coords$sample_id <- rownames(coords)

# From a pre-computed distance matrix
dm <- vegdist(otu_mat, method = "bray")
nmds <- metaMDS(dm, k = 2, trymax = 100, trace = 0)

# Increase dimensions if stress is too high
nmds_3d <- metaMDS(otu_mat, distance = "bray", k = 3, trymax = 100, trace = 0)

# Shepard diagram (stress plot) — visualize ordination fit
png("figures/nmds_stressplot.png", width = 800, height = 600, res = 150)
stressplot(nmds)
dev.off()

# Goodness of fit per point
gof <- goodness(nmds)

# Resume from previous best solution
nmds <- metaMDS(otu_mat, distance = "bray", k = 2, trymax = 200,
                previous.best = nmds, trace = 0)
```

### NMDS Ordination Plot with ggplot2

```r
library(ggplot2)

coords <- as.data.frame(nmds$points)
colnames(coords) <- c("NMDS1", "NMDS2")
coords$sample_id <- rownames(coords)
coords <- merge(coords, meta_df, by.x = "sample_id", by.y = "row.names")

p <- ggplot(coords, aes(x = NMDS1, y = NMDS2, color = group)) +
  geom_point(size = 3, alpha = 0.8) +
  stat_ellipse(level = 0.95, linetype = "dashed") +
  labs(title = paste0("NMDS (stress = ", round(nmds$stress, 3), ")"),
       color = "Group") +
  theme_minimal()
ggsave("figures/nmds_ordination.png", p, width = 8, height = 6, dpi = 300)
ggsave("figures/nmds_ordination.pdf", p, width = 8, height = 6)
```

## adonis2() — PERMANOVA

Permutational Multivariate Analysis of Variance. Tests whether group centroids differ in multivariate space. Uses a formula interface with support for covariates, interactions, and stratified permutations.

```r
result <- adonis2(
  formula,               # formula — response ~ predictors (response is community matrix or dist)
  data,                  # data.frame — metadata with predictor variables
  permutations = 999,    # int — number of permutations
  method = "bray",       # character — distance method (used only if formula LHS is a matrix)
  sqrt.dist = FALSE,     # logical — take square root of distances
  add = FALSE,           # logical — Lingoes correction for negative eigenvalues
  by = NULL,             # NULL|"terms"|"margin" — type of test (see below)
  parallel = getOption("mc.cores"),  # int — parallel permutations
  na.action = na.fail,   # function — handling of NAs
  strata = NULL,         # factor — restrict permutations within strata (nested designs)
  ...
)
```

### adonis2() `by` Parameter

- `NULL` (default) — Overall (omnibus) test. Single F-test for the full model. Reports one R2 for the entire model.
- `"terms"` — Sequential (Type I) tests. Each term tested after adding terms before it. Order of terms in the formula matters.
- `"margin"` — Marginal (Type III) tests. Each term tested after all other terms. Order-independent. Use for balanced evaluation of each predictor.

### adonis2() Return Value

Returns an `anova.cca` object (data.frame-like) with columns:

```r
# Columns:
#   Df        — degrees of freedom
#   SumOfSqs  — sum of squares (variance explained)
#   R2        — proportion of variance explained
#   F         — pseudo-F statistic
#   Pr(>F)    — permutation p-value
```

### PERMANOVA Usage Examples

```r
# Basic two-group PERMANOVA on pre-computed distance matrix
dm <- vegdist(otu_mat, method = "bray")
result <- adonis2(dm ~ group, data = meta_df, permutations = 999)
print(result)

# PERMANOVA on raw community matrix (vegdist called internally)
result <- adonis2(otu_mat ~ group, data = meta_df, permutations = 999, method = "bray")

# Multi-factor with covariates (marginal tests)
result <- adonis2(dm ~ group + age + sex, data = meta_df,
                  permutations = 999, by = "margin")

# Interaction term
result <- adonis2(dm ~ group * treatment, data = meta_df,
                  permutations = 999, by = "terms")

# Nested / stratified design (permute within strata only)
result <- adonis2(dm ~ treatment, data = meta_df,
                  permutations = 999, strata = meta_df$site)

# Extract R2 and p-value for the first term
r2 <- result$R2[1]
pval <- result$`Pr(>F)`[1]
cat("R2 =", r2, ", p =", pval, "\n")

# Save PERMANOVA results
permanova_df <- as.data.frame(result)
permanova_df$term <- rownames(permanova_df)
write.csv(permanova_df, "output/permanova_results.csv", row.names = FALSE)
```

## betadisper() — Multivariate Dispersion (PERMDISP2)

Tests homogeneity of multivariate dispersions across groups. Multivariate analogue of Levene's test. Essential companion to PERMANOVA — a significant PERMANOVA with unequal dispersions may reflect dispersion differences rather than centroid shifts.

```r
mod <- betadisper(
  d,                     # dist object — distance/dissimilarity matrix
  group,                 # factor — group assignments per sample
  type = "median",       # "median"|"centroid" — type of group center
  bias.adjust = FALSE,   # logical — small-sample bias correction
  sqrt.dist = FALSE,     # logical — take square root of distances
  add = FALSE            # logical|"lingoes"|"cailliez" — correction for negative eigenvalues
)
```

### betadisper() Key Return Values

```r
mod$distances     # numeric vector — distance of each sample to its group center
mod$group         # factor — group assignments
mod$centroids     # matrix — group center coordinates in PCoA space
mod$eig           # numeric — eigenvalues from underlying PCoA
```

### permutest() — Permutation Test for betadisper

```r
perm_result <- permutest(
  mod,                   # betadisper object
  pairwise = FALSE,      # logical — pairwise group comparisons
  permutations = 999,    # int — number of permutations
  parallel = getOption("mc.cores")
)
```

### betadisper Usage Examples

```r
# Compute distance matrix
dm <- vegdist(otu_mat, method = "bray")

# Calculate multivariate dispersions (spatial median, default)
mod <- betadisper(dm, meta_df$group)

# Permutation test for homogeneity of dispersions
perm <- permutest(mod, permutations = 999, pairwise = TRUE)
print(perm)

# Parametric ANOVA on distances to centroid (less preferred than permutation)
anova(mod)

# Tukey HSD for pairwise comparisons (>2 groups)
tukey <- TukeyHSD(mod)
print(tukey)

# Extract distances to group centroids
disp_df <- data.frame(
  sample_id = names(mod$distances),
  group = mod$group,
  distance_to_centroid = as.numeric(mod$distances)
)
write.csv(disp_df, "output/betadisper_distances.csv", row.names = FALSE)

# Boxplot of distances to centroid
png("figures/betadisper_boxplot.png", width = 800, height = 600, res = 150)
boxplot(mod, xlab = "Group", ylab = "Distance to centroid",
        main = "Multivariate Dispersion")
dev.off()

# PCoA-based dispersion plot with group hulls
png("figures/betadisper_plot.png", width = 800, height = 600, res = 150)
plot(mod)
dev.off()

# With ellipses instead of hulls
png("figures/betadisper_ellipse.png", width = 800, height = 600, res = 150)
plot(mod, ellipse = TRUE, hull = FALSE, conf = 0.95)
dev.off()
```

## Common Patterns

### Full Beta Diversity Pipeline (PERMANOVA + Dispersion Check)

Always run `betadisper` alongside `adonis2`. This is the standard beta diversity workflow.

```r
library(vegan)
library(ggplot2)

# 1. Compute distance matrix
dm <- vegdist(otu_mat, method = "bray")

# 2. Check dispersion homogeneity FIRST
mod <- betadisper(dm, meta_df$group)
disp_test <- permutest(mod, permutations = 999, pairwise = TRUE)
cat("Dispersion test p-value:", disp_test$tab$`Pr(>F)`[1], "\n")

# 3. PERMANOVA
permanova <- adonis2(dm ~ group, data = meta_df, permutations = 999)
cat("PERMANOVA R2:", permanova$R2[1], "p:", permanova$`Pr(>F)`[1], "\n")

# 4. NMDS ordination for visualization
nmds <- metaMDS(dm, k = 2, trymax = 100, trace = 0)

# 5. Ordination plot
coords <- as.data.frame(nmds$points)
colnames(coords) <- c("NMDS1", "NMDS2")
coords$sample_id <- rownames(coords)
coords <- merge(coords, meta_df, by.x = "sample_id", by.y = "row.names")

p <- ggplot(coords, aes(x = NMDS1, y = NMDS2, color = group)) +
  geom_point(size = 3) +
  stat_ellipse(level = 0.95, linetype = "dashed") +
  labs(title = paste0("NMDS (stress = ", round(nmds$stress, 3), ")\n",
                      "PERMANOVA R2 = ", round(permanova$R2[1], 3),
                      ", p = ", permanova$`Pr(>F)`[1])) +
  theme_minimal()
ggsave("figures/beta_diversity_nmds.png", p, width = 8, height = 6, dpi = 300)
ggsave("figures/beta_diversity_nmds.pdf", p, width = 8, height = 6)
```

### Multi-Factor PERMANOVA with Strata

```r
# Nested design: treatment within site
dm <- vegdist(otu_mat, method = "bray")

# Stratified permutations — permute treatment labels only within each site
result <- adonis2(dm ~ treatment + age, data = meta_df,
                  permutations = 999, strata = meta_df$site, by = "margin")
print(result)
```

### Integration with phyloseq

```r
library(phyloseq)
library(vegan)

# Extract components from phyloseq object
otu_mat <- as.matrix(otu_table(ps))
if (taxa_are_rows(ps)) otu_mat <- t(otu_mat)   # vegan needs samples as rows
meta_df <- as(sample_data(ps), "data.frame")

# Or use phyloseq::distance() and pass dist to adonis2 / betadisper
dm <- distance(ps, method = "bray")
result <- adonis2(dm ~ group, data = meta_df, permutations = 999)
mod <- betadisper(dm, meta_df$group)
```

## decostand() — Data Standardization

Standardize community data before computing distances. Useful for compositional transformations.

```r
std <- decostand(
  x,                     # matrix/data.frame — community data
  method,                # character — standardization method (see below)
  MARGIN = 1,            # int — 1 = rows (samples), 2 = columns (species)
  na.rm = FALSE
)
```

### Key Standardization Methods

| Method | `method =` | Description |
|--------|------------|-------------|
| Hellinger | `"hellinger"` | Square root of relative abundance. Recommended pre-transform for RDA/PCA. |
| CLR | `"clr"` | Centered log-ratio. Compositionally aware. Requires no zeros. |
| Robust CLR | `"rclr"` | Robust CLR. Handles zeros. Use with Euclidean distance for Aitchison. |
| Wisconsin double | `"wisconsin"` | Species max then sample total standardization. metaMDS applies automatically. |
| Normalize | `"norm"` | Euclidean norm (vector length = 1). For Chord distance: `vegdist(decostand(x, "norm"), "euclidean")`. |
| Range | `"range"` | Scale to [0, 1] by column range. |
| Total | `"total"` | Divide by row total (relative abundance). |
| Log | `"log"` | Log transformation with configurable base. |

## diversity() — Alpha Diversity Indices

```r
# Shannon diversity (natural log, base e)
H <- diversity(otu_mat, index = "shannon")

# Simpson diversity
D <- diversity(otu_mat, index = "simpson")

# Inverse Simpson
invD <- diversity(otu_mat, index = "invsimpson")
```

## Gotchas

- **vegan expects samples as rows, taxa as columns.** This is the opposite of phyloseq's default (`taxa_are_rows = TRUE`). Always transpose with `t()` when extracting from phyloseq: `otu_mat <- t(as.matrix(otu_table(ps)))`.
- **PERMANOVA is sensitive to heterogeneous dispersion.** A significant `adonis2` result when `betadisper` also shows significant dispersion differences is ambiguous — the PERMANOVA may be detecting dispersion differences rather than centroid shifts. Always report both tests together.
- **Run `betadisper` BEFORE interpreting PERMANOVA.** If dispersions are unequal, PERMANOVA results must be interpreted cautiously. The effect may be driven by within-group variability rather than between-group differences.
- **`adonis2` term order matters with `by = "terms"` (Type I).** Sequential tests are order-dependent. Put the variable of interest first, or use `by = "margin"` for order-independent marginal tests.
- **`adonis2` formula left-hand side can be a matrix or dist.** If a community matrix, `vegdist()` is called internally with the specified `method`. If a `dist` object, the `method` parameter is ignored.
- **`metaMDS` may not converge.** Check `nmds$stress` and `nmds$converged`. If stress > 0.2, increase `trymax` (e.g., 200-500) or try `k = 3` dimensions. If it still fails, the data may not have a low-dimensional structure.
- **`metaMDS` auto-transforms by default.** `autotransform = TRUE` applies Wisconsin double standardization + square root if the data range is large. Set `autotransform = FALSE` if you pre-standardized the data or are passing a `dist` object.
- **`vegdist` with `method = "jaccard"` on abundance data computes a quantitative Jaccard.** For classic binary Jaccard, set `binary = TRUE`.
- **Permutation count matters.** Use `permutations = 999` minimum (the default). For publication, use `permutations = 9999`. Fewer permutations give coarse p-values (e.g., 99 permutations cannot produce p < 0.01).
- **`strata` in `adonis2` restricts permutations within strata.** Use for nested or blocked designs (e.g., patients within hospitals). Without `strata`, permutations are unrestricted across all samples.
- **Negative eigenvalues in `betadisper`.** Non-Euclidean distances (like Bray-Curtis) can produce negative eigenvalues in the underlying PCoA. Use `add = "lingoes"` or `sqrt.dist = TRUE` to correct. Check with `mod$eig` — negative values indicate the issue.
- **`diversity()` expects samples as rows.** Same orientation as `vegdist`.
