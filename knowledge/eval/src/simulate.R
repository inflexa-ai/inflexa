#!/usr/bin/env Rscript
# Negative binomial count simulator for the Phase 0 evaluation and the
# template tests. Base R only. One design pattern, one seed, one output
# directory. The truth rides beside the counts.
#
# Usage:
#   Rscript simulate.R --pattern two_group_n6 --seed 1 --out dir [--hallmark path.gmt] [--n-genes 12000]
#
# Patterns:
#   two_group_n3, two_group_n6, paired_n5, batch_balanced_n6, interaction_2x2_n4,
#   timecourse_2x4_n3, confounded_batch_n6, no_replicates_1v1, multi_group_3x4,
#   outlier_n5, two_group_n60, covariates_n6, timecourse_2x2_n3, paired_3groups_n4,
#   survival_n60, regulons_n6, coexpression_n60, salmon_two_group_n6, isoform_switch_n6,
#   timecourse_1x4_n3, mouse_two_group_n6
#
# timecourse_1x4_n3 follows one group over four time points with three
# replicates each: 15% of the expressed genes carry a slope over time
# (planted_set "time"), and no condition column exists.
#
# mouse_two_group_n6 takes the design of two_group_n6 and writes the gene
# symbols in the title case of a mouse symbol (CD3E becomes Cd3e). The case
# change is a fixture device for a mouse marker table, not an ortholog map;
# the hallmark sets do not match these names, thus no hallmark set is planted.
#
# Quantification patterns (QUANT_PATTERNS below) also write quant/<sample>/quant.sf
# and tx2gene.csv from the gene counts, after every other output: each gene
# gets one to four isoforms with log-normal lengths around its gene length and
# a usage per sample, and the reads of a gene split over its isoforms by that
# usage. The sum of NumReads per gene stays the gene count up to a small
# multi-mapping noise, thus a length offset changes the fit and not the truth.
#
# Salmon patterns: salmon_two_group_n6 and isoform_switch_n6 take the design of
# two_group_n6 and draw the counts per transcript, not per gene. Each gene has
# one to four isoforms with log-normal lengths around a gene length and a base
# usage per group; a sample draws its own usage around that base. The expected
# reads of an isoform scale with its effective length at equal molecules, as in
# the quantifier's model, thus a longer isoform collects more reads. The pattern
# writes quant/<sample>/quant.sf (Name, Length, EffectiveLength, TPM, NumReads
# with fractional NumReads), tx2gene.csv, and transcripts.csv; counts.csv keeps
# the naive integer sum of NumReads per gene. isoform_switch_n6 moves the
# dominant usage (0.85) of 300 expressed non-DE genes from the shortest to the
# longest isoform in the treated group at unchanged molar abundance
# (planted_set ISOFORM_SWITCH, de 0): the naive sum calls them, the length
# offset does not.
#
# Regulons: when --regulons names a CollecTRI-style CSV (source,target,weight),
# three regulators with enough targets in the gene universe are planted with a
# coherent target response in the treated group, thus a regulator activity step
# has a truth (planted_set "TF:<name>").
#
# Every pattern also writes log_expr.csv (log2(TPM + 1)) for the templates that
# take log-scale input.
#
# Every pattern also writes tpm.csv and gene_lengths.csv (a TPM matrix from the
# counts and simulated gene lengths) for the templates that take abundance
# input. The lengths are drawn after the counts, thus the counts of a pattern
# do not change with this addition.
#
# Model: counts ~ NB(mu = s_i * 2^(mu_g + x_i' beta_g), size = 1/phi_g), with a
# log-normal baseline, a dispersion that falls with the mean, and per-sample
# size factors. A share of genes carries an effect for each design term. Three
# MSigDB Hallmark sets are planted with a coherent direction when a GMT file is
# given, thus an enrichment step has a truth.

args <- commandArgs(trailingOnly = TRUE)
option <- function(name, default = NULL) {
  index <- match(name, args)
  if (is.na(index) || index == length(args)) default else args[index + 1]
}
PATTERN <- option("--pattern", "two_group_n6")
SEED <- as.integer(option("--seed", "1"))
OUT <- option("--out", file.path("eval", "data", PATTERN, paste0("seed-", SEED)))
HALLMARK <- option("--hallmark", NULL)
REGULONS <- option("--regulons", NULL)
N_GENES <- as.integer(option("--n-genes", "12000"))
SALMON_PATTERNS <- c("salmon_two_group_n6", "isoform_switch_n6")
QUANT_PATTERNS <- c("two_group_n3", "paired_n5", "batch_balanced_n6", "interaction_2x2_n4", "timecourse_2x4_n3", "timecourse_1x4_n3", "multi_group_3x4", "outlier_n5", "two_group_n60", "paired_3groups_n4")
set.seed(SEED)
dir.create(OUT, showWarnings = FALSE, recursive = TRUE)

# ── Gene universe ─────────────────────────────────────────────────────────────
gene_sets <- list()
if (!is.null(HALLMARK) && file.exists(HALLMARK)) {
  for (line in readLines(HALLMARK)) {
    fields <- strsplit(line, "\t", fixed = TRUE)[[1]]
    if (length(fields) > 2) gene_sets[[fields[1]]] <- fields[-(1:2)]
  }
}
hallmark_genes <- unique(unlist(gene_sets))
n_synthetic <- max(0, N_GENES - length(hallmark_genes))
genes <- c(hallmark_genes, sprintf("GENE%05d", seq_len(n_synthetic)))
genes <- genes[seq_len(min(N_GENES, length(genes)))]
if (PATTERN == "mouse_two_group_n6") genes <- paste0(substr(genes, 1, 1), tolower(substring(genes, 2)))
n_genes <- length(genes)

# ── Design ────────────────────────────────────────────────────────────────────
make_design <- function(pattern) {
  if (pattern == "two_group_n3") {
    meta <- data.frame(condition = rep(c("control", "treated"), each = 3))
  } else if (pattern %in% c("two_group_n6", "mouse_two_group_n6", SALMON_PATTERNS)) {
    meta <- data.frame(condition = rep(c("control", "treated"), each = 6))
  } else if (pattern == "paired_n5") {
    meta <- data.frame(subject = rep(sprintf("S%02d", 1:5), times = 2), condition = rep(c("control", "treated"), each = 5))
  } else if (pattern == "batch_balanced_n6") {
    meta <- data.frame(condition = rep(c("control", "treated"), each = 6), batch = rep(c("B1", "B2"), times = 6))
  } else if (pattern == "interaction_2x2_n4") {
    meta <- expand.grid(replicate = 1:4, genotype = c("WT", "KO"), treatment = c("vehicle", "drug"), stringsAsFactors = FALSE)[, c("genotype", "treatment")]
    meta$condition <- paste(meta$genotype, meta$treatment, sep = "_")
  } else if (pattern == "timecourse_2x4_n3") {
    meta <- expand.grid(replicate = 1:3, time = c("t0", "t1", "t2", "t3"), condition = c("control", "treated"), stringsAsFactors = FALSE)[, c("condition", "time")]
    meta$time_hours <- as.integer(factor(meta$time)) - 1L
  } else if (pattern == "confounded_batch_n6") {
    meta <- data.frame(condition = rep(c("control", "treated"), each = 6), batch = rep(c("B1", "B2"), each = 6))
  } else if (pattern == "no_replicates_1v1") {
    meta <- data.frame(condition = c("control", "treated"))
  } else if (pattern == "multi_group_3x4") {
    meta <- data.frame(condition = rep(c("control", "treated_a", "treated_b"), each = 4))
  } else if (pattern == "outlier_n5") {
    meta <- data.frame(condition = rep(c("control", "treated"), each = 5))
  } else if (pattern == "two_group_n60") {
    meta <- data.frame(condition = rep(c("control", "treated"), each = 60))
  } else if (pattern == "covariates_n6") {
    meta <- data.frame(condition = rep(c("control", "treated"), each = 6), sex = rep(c("F", "M"), times = 6), age = round(runif(12, 25, 75)))
  } else if (pattern == "timecourse_1x4_n3") {
    meta <- expand.grid(replicate = 1:3, time = c("t0", "t1", "t2", "t3"), stringsAsFactors = FALSE)[, "time", drop = FALSE]
    meta$time_hours <- as.integer(factor(meta$time)) - 1L
  } else if (pattern == "timecourse_2x2_n3") {
    meta <- expand.grid(replicate = 1:3, time = c("t0", "t1"), condition = c("control", "treated"), stringsAsFactors = FALSE)[, c("condition", "time")]
    meta$time_hours <- as.integer(factor(meta$time)) - 1L
  } else if (pattern == "survival_n60") {
    meta <- data.frame(condition = rep(c("control", "treated"), each = 60))
  } else if (pattern == "regulons_n6") {
    meta <- data.frame(condition = rep(c("control", "treated"), each = 6))
  } else if (pattern == "coexpression_n60") {
    meta <- data.frame(condition = rep(c("control", "treated"), each = 60))
  } else if (pattern == "paired_3groups_n4") {
    meta <- data.frame(subject = rep(sprintf("S%02d", 1:4), times = 3), condition = rep(c("control", "treated_a", "treated_b"), each = 4))
  } else {
    stop("unknown pattern ", pattern)
  }
  meta$sample <- sprintf("sample_%02d", seq_len(nrow(meta)))
  meta[, c("sample", setdiff(colnames(meta), "sample"))]
}
meta <- make_design(PATTERN)
n_samples <- nrow(meta)

# ── Per-gene baseline and dispersion ──────────────────────────────────────────
baseline_log2 <- rnorm(n_genes, mean = 5.5, sd = 2.2)
baseline_mean <- 2^baseline_log2
dispersion <- 0.08 + 3 / baseline_mean + rexp(n_genes, rate = 20)

# ── Effects ───────────────────────────────────────────────────────────────────
effect_size <- function(n) sign(rnorm(n)) * (0.6 + abs(rnorm(n, sd = 0.9)))
# An effect lands only on an expressed gene (baseline mean >= 8 counts), because a
# differential effect on a gene that no sample detects is not a recoverable truth.
expressed <- which(baseline_mean >= 8)
sample_expressed <- function(share) sample(expressed, size = round(share * n_genes))
truth <- data.frame(gene = genes, de = 0L, lfc = 0, planted_set = "", stringsAsFactors = FALSE)
log_mu <- matrix(baseline_log2, nrow = n_genes, ncol = n_samples)

plant_hallmark <- function(condition_column, test_level) {
  if (length(gene_sets) == 0) return(invisible(NULL))
  chosen <- c("HALLMARK_INTERFERON_GAMMA_RESPONSE", "HALLMARK_TNFA_SIGNALING_VIA_NFKB", "HALLMARK_OXIDATIVE_PHOSPHORYLATION")
  directions <- c(1, 1, -1)
  for (k in seq_along(chosen)) {
    members <- intersect(gene_sets[[chosen[k]]], genes)
    if (length(members) == 0) next
    members <- members[baseline_mean[match(members, genes)] >= 8]
    if (length(members) == 0) next
    hit <- sample(members, size = round(0.6 * length(members)))
    index <- match(hit, genes)
    lfc <- directions[k] * (0.7 + abs(rnorm(length(index), sd = 0.6)))
    in_test <- meta[[condition_column]] == test_level
    log_mu[index, in_test] <<- log_mu[index, in_test] + lfc
    truth$de[index] <<- 1L
    truth$lfc[index] <<- lfc
    truth$planted_set[index] <<- chosen[k]
  }
}

# ── Regulons ──────────────────────────────────────────────────────────────────
regulons <- list()
if (!is.null(REGULONS) && file.exists(REGULONS)) {
  reg <- read.csv(REGULONS, stringsAsFactors = FALSE)
  reg <- reg[reg$target %in% genes, c("source", "target", "weight")]
  for (tf in unique(reg$source)) regulons[[tf]] <- reg[reg$source == tf, ]
}
plant_regulons <- function(condition_column, test_level) {
  if (length(regulons) == 0) return(invisible(NULL))
  sizes <- vapply(regulons, function(r) sum(baseline_mean[match(r$target, genes)] >= 8), 0L)
  eligible <- names(sizes)[sizes >= 20 & sizes <= 200]
  if (length(eligible) < 3) return(invisible(NULL))
  chosen <- sample(eligible, 3)
  in_test <- meta[[condition_column]] == test_level
  for (tf in chosen) {
    r <- regulons[[tf]]
    r <- r[baseline_mean[match(r$target, genes)] >= 8, ]
    hit <- r[sample(seq_len(nrow(r)), size = round(0.7 * nrow(r))), ]
    index <- match(hit$target, genes)
    # The regulator is active in the test group: each target moves with the sign of its edge.
    lfc <- sign(hit$weight) * (0.8 + abs(rnorm(length(index), sd = 0.5)))
    log_mu[index, in_test] <<- log_mu[index, in_test] + lfc
    truth$de[index] <<- 1L
    truth$lfc[index] <<- lfc
    truth$planted_set[index] <<- ifelse(truth$planted_set[index] == "", paste0("TF:", tf), truth$planted_set[index])
  }
}

if (PATTERN %in% c("two_group_n3", "two_group_n6", "mouse_two_group_n6", "batch_balanced_n6", "confounded_batch_n6", "no_replicates_1v1", "paired_n5", "outlier_n5", "two_group_n60", "covariates_n6", "survival_n60", "regulons_n6", "coexpression_n60", SALMON_PATTERNS)) {
  de_index <- sample_expressed(0.10)
  lfc <- effect_size(length(de_index))
  treated <- meta$condition == "treated"
  log_mu[de_index, treated] <- log_mu[de_index, treated] + lfc
  truth$de[de_index] <- 1L
  truth$lfc[de_index] <- lfc
  plant_hallmark("condition", "treated")
  # Only the regulons pattern plants regulators, thus the counts of every other pattern stay as they were.
  if (PATTERN == "regulons_n6") plant_regulons("condition", "treated")
}
if (PATTERN == "paired_n5") {
  subject_effect <- matrix(rnorm(n_genes * 5, sd = 0.45), nrow = n_genes)
  for (i in seq_len(n_samples)) log_mu[, i] <- log_mu[, i] + subject_effect[, as.integer(factor(meta$subject))[i]]
}
if (PATTERN == "covariates_n6") {
  # A sex effect on 5% of the genes and an age slope on 3%, both nuisance terms
  # the design must hold; the truth stays the condition effect.
  sex_index <- sample_expressed(0.05)
  log_mu[sex_index, meta$sex == "M"] <- log_mu[sex_index, meta$sex == "M"] + effect_size(length(sex_index))
  age_index <- sample_expressed(0.03)
  age_slope <- rnorm(length(age_index), sd = 0.02)
  for (i in seq_len(n_samples)) log_mu[age_index, i] <- log_mu[age_index, i] + age_slope * (meta$age[i] - 50)
}
if (PATTERN == "paired_3groups_n4") {
  subject_effect <- matrix(rnorm(n_genes * 4, sd = 0.45), nrow = n_genes)
  for (i in seq_len(n_samples)) log_mu[, i] <- log_mu[, i] + subject_effect[, as.integer(factor(meta$subject))[i]]
  a_index <- sample_expressed(0.08)
  b_index <- unique(c(sample(a_index, size = round(0.5 * length(a_index))), sample_expressed(0.06)))
  a_lfc <- effect_size(length(a_index)); b_lfc <- effect_size(length(b_index))
  log_mu[a_index, meta$condition == "treated_a"] <- log_mu[a_index, meta$condition == "treated_a"] + a_lfc
  log_mu[b_index, meta$condition == "treated_b"] <- log_mu[b_index, meta$condition == "treated_b"] + b_lfc
  truth$de[c(a_index, b_index)] <- 1L
  truth$lfc[a_index] <- a_lfc; truth$lfc[b_index] <- b_lfc
  truth$planted_set[a_index] <- "treated_a"
  truth$planted_set[b_index] <- ifelse(truth$planted_set[b_index] == "treated_a", "treated_a_and_b", "treated_b")
  plant_hallmark("condition", "treated_a")
}
if (PATTERN == "timecourse_2x2_n3") {
  # Two time points: the truth is the condition-by-time interaction, the genes
  # whose change over time differs between the groups.
  time_index <- sample_expressed(0.10)
  log_mu[time_index, meta$time_hours == 1] <- log_mu[time_index, meta$time_hours == 1] + effect_size(length(time_index))
  interaction_index <- sample_expressed(0.06)
  interaction_lfc <- sign(rnorm(length(interaction_index))) * (1.2 + abs(rnorm(length(interaction_index), sd = 0.8)))
  late_treated <- meta$condition == "treated" & meta$time_hours == 1
  log_mu[interaction_index, late_treated] <- log_mu[interaction_index, late_treated] + interaction_lfc
  truth$de[interaction_index] <- 1L
  truth$lfc[interaction_index] <- interaction_lfc
  truth$planted_set[interaction_index] <- "condition_by_time"
}
if (PATTERN %in% c("batch_balanced_n6", "confounded_batch_n6")) {
  batch_index <- sample(seq_len(n_genes), size = round(0.30 * n_genes))
  batch_lfc <- rnorm(length(batch_index), sd = 0.6)
  in_b2 <- meta$batch == "B2"
  log_mu[batch_index, in_b2] <- log_mu[batch_index, in_b2] + batch_lfc
}
if (PATTERN == "interaction_2x2_n4") {
  genotype_index <- sample_expressed(0.08)
  treatment_index <- sample_expressed(0.08)
  interaction_index <- sample_expressed(0.05)
  ko <- meta$genotype == "KO"
  drug <- meta$treatment == "drug"
  log_mu[genotype_index, ko] <- log_mu[genotype_index, ko] + effect_size(length(genotype_index))
  log_mu[treatment_index, drug] <- log_mu[treatment_index, drug] + effect_size(length(treatment_index))
  # The interaction coefficient at 4 samples per cell has twice the standard
  # error of a two-group effect, thus the planted interaction is larger.
  interaction_lfc <- sign(rnorm(length(interaction_index))) * (1.2 + abs(rnorm(length(interaction_index), sd = 0.8)))
  log_mu[interaction_index, ko & drug] <- log_mu[interaction_index, ko & drug] + interaction_lfc
  truth$de[interaction_index] <- 1L
  truth$lfc[interaction_index] <- interaction_lfc
  truth$planted_set[interaction_index] <- "interaction"
}
if (PATTERN == "multi_group_3x4") {
  # Two treated groups against one control. Half of the genes of group B also
  # move in group A, thus the any-difference test and the pairwise contrasts
  # have distinct truths: `de` marks a gene that moves in any group.
  a_index <- sample_expressed(0.08)
  b_index <- c(sample(a_index, size = round(0.5 * length(a_index))), sample_expressed(0.06))
  b_index <- unique(b_index)
  a_lfc <- effect_size(length(a_index))
  b_lfc <- effect_size(length(b_index))
  in_a <- meta$condition == "treated_a"
  in_b <- meta$condition == "treated_b"
  log_mu[a_index, in_a] <- log_mu[a_index, in_a] + a_lfc
  log_mu[b_index, in_b] <- log_mu[b_index, in_b] + b_lfc
  truth$de[c(a_index, b_index)] <- 1L
  truth$lfc[a_index] <- a_lfc
  truth$lfc[b_index] <- b_lfc
  truth$planted_set[a_index] <- "treated_a"
  truth$planted_set[b_index] <- ifelse(truth$planted_set[b_index] == "treated_a", "treated_a_and_b", "treated_b")
  plant_hallmark("condition", "treated_a")
}
if (PATTERN == "timecourse_2x4_n3") {
  time_index <- sample_expressed(0.15)
  slope <- rnorm(length(time_index), sd = 0.35)
  for (i in seq_len(n_samples)) log_mu[time_index, i] <- log_mu[time_index, i] + slope * meta$time_hours[i]
  interaction_index <- sample_expressed(0.05)
  # A 3 df interaction test at 3 samples per cell needs a slope near 0.6 log2
  # per unit of time to find a gene, thus the planted slope starts there.
  interaction_slope <- sign(rnorm(length(interaction_index))) * (0.6 + abs(rnorm(length(interaction_index), sd = 0.3)))
  treated <- meta$condition == "treated"
  for (i in which(treated)) log_mu[interaction_index, i] <- log_mu[interaction_index, i] + interaction_slope * meta$time_hours[i]
  truth$de[interaction_index] <- 1L
  truth$lfc[interaction_index] <- interaction_slope * 3
  truth$planted_set[interaction_index] <- "condition_by_time"
}

if (PATTERN == "timecourse_1x4_n3") {
  # One group over time: the truth is the set of genes with a slope over time.
  # A 3 df test at 3 samples per time point finds a slope near 0.4 log2 per
  # unit of time, thus the planted slope starts there.
  time_index <- sample_expressed(0.15)
  slope <- sign(rnorm(length(time_index))) * (0.4 + abs(rnorm(length(time_index), sd = 0.3)))
  for (i in seq_len(n_samples)) log_mu[time_index, i] <- log_mu[time_index, i] + slope * meta$time_hours[i]
  truth$de[time_index] <- 1L
  truth$lfc[time_index] <- slope * 3
  truth$planted_set[time_index] <- "time"
}

# ── Co-expression modules (three latent sample factors, independent of the condition) ──
if (PATTERN == "coexpression_n60") {
  for (k in 1:3) {
    members <- sample(setdiff(expressed, which(truth$de == 1L)), 150)
    factor_score <- rnorm(n_samples, sd = 1)
    loading <- 0.6 + abs(rnorm(length(members), sd = 0.3))
    for (i in seq_len(n_samples)) log_mu[members, i] <- log_mu[members, i] + loading * factor_score[i]
    truth$planted_set[members] <- paste0("MODULE_", k)
  }
}

# ── One outlier sample ────────────────────────────────────────────────────────
# A control sample with a gene-wise shift of its expected expression, the
# pattern of a degraded or mishandled library: the sample stays in its group
# on the largest axes, but its residual variance is far above the others.
outlier_sample <- NA_character_
if (PATTERN == "outlier_n5") {
  outlier <- which(meta$condition == "control")[3]
  log_mu[, outlier] <- log_mu[, outlier] + rnorm(n_genes, sd = 1.1)
  outlier_sample <- meta$sample[outlier]
}

# ── Size factors and one low-depth sample ─────────────────────────────────────
size_factors <- exp(rnorm(n_samples, sd = 0.2))
low_depth_sample <- NA_character_
if (PATTERN %in% c("two_group_n6", "batch_balanced_n6")) {
  low <- which(meta$condition == "control")[1]
  size_factors[low] <- 0.25
  low_depth_sample <- meta$sample[low]
}

# ── Sample counts ─────────────────────────────────────────────────────────────
counts <- matrix(0L, nrow = n_genes, ncol = n_samples, dimnames = list(genes, meta$sample))
n_transcripts <- NA_integer_
switch_genes <- integer(0)
if (PATTERN %in% SALMON_PATTERNS) {
  # ── Transcripts (the Salmon patterns only, thus the counts of every other pattern stay) ──
  # Each gene has one to four isoforms with log-normal lengths around a gene
  # length. The gene length of the fixture is the mean isoform length. The
  # effective length follows the quantifier's convention, length - 200 + 1.
  center_length <- exp(rnorm(n_genes, mean = log(2000), sd = 0.6))
  n_tx <- sample(1:4, n_genes, replace = TRUE)
  tx_gene <- rep(seq_len(n_genes), n_tx)
  n_transcripts <- length(tx_gene)
  tx_name <- paste0(genes[tx_gene], "-T", sequence(n_tx))
  tx_length <- pmax(400L, as.integer(round(center_length[tx_gene] * exp(rnorm(n_transcripts, sd = 0.5)))))
  tx_effective <- pmax(tx_length - 200L + 1L, 1L)
  gene_lengths <- as.integer(round(rowsum(tx_length, tx_gene) / n_tx))
  mean_effective <- as.numeric(rowsum(tx_effective, tx_gene) / n_tx)
  # The base usage of a gene: the same in both groups, except for a switch gene.
  base <- rgamma(n_transcripts, shape = 2)
  control_p <- base / rowsum(base, tx_gene)[tx_gene]
  treated_p <- control_p
  if (PATTERN == "isoform_switch_n6") {
    # 300 expressed non-DE genes with two or more isoforms and a length ratio of
    # at least 2.5 between the longest and the shortest. The control group puts
    # 0.85 of the usage on the shortest isoform, the treated group on the
    # longest; the molar abundance (log_mu) does not change, thus de stays 0.
    ratio <- vapply(split(tx_length, tx_gene), function(l) max(l) / min(l), 0)
    candidates <- intersect(expressed, which(truth$de == 0L & n_tx >= 2 & ratio >= 2.5))
    if (length(candidates) < 300) stop("only ", length(candidates), " genes qualify for an isoform switch")
    switch_genes <- sort(sample(candidates, 300))
    for (g in switch_genes) {
      index <- which(tx_gene == g)
      minor <- 0.15 / (length(index) - 1)
      control_p[index] <- minor
      control_p[index[which.min(tx_length[index])]] <- 0.85
      treated_p[index] <- minor
      treated_p[index[which.max(tx_length[index])]] <- 0.85
    }
    truth$planted_set[switch_genes] <- "ISOFORM_SWITCH"
  }
  # A sample draws its usage around the base of its group (a Dirichlet with
  # concentration 50). The expected reads of an isoform are the molar abundance
  # of the gene times its usage times its effective length, relative to the
  # mean effective length of the gene, thus a gene with even usage keeps the
  # expected count of the gene model. NumReads is the count with a multi-mapping
  # share, thus it is fractional as in a quant.sf.
  tx_counts <- matrix(0L, nrow = n_transcripts, ncol = n_samples)
  num_reads <- matrix(0, nrow = n_transcripts, ncol = n_samples)
  for (i in seq_len(n_samples)) {
    base_p <- if (meta$condition[i] == "treated") treated_p else control_p
    usage <- rgamma(n_transcripts, shape = 50 * base_p)
    p <- usage / rowsum(usage, tx_gene)[tx_gene]
    mu <- size_factors[i] * 2^log_mu[tx_gene, i] * p * tx_effective / mean_effective[tx_gene]
    tx_counts[, i] <- rnbinom(n_transcripts, mu = mu, size = 1 / dispersion[tx_gene])
    num_reads[, i] <- round(tx_counts[, i] * runif(n_transcripts, 0.85, 1.15), 3)
  }
  # The naive integer sum per gene: what a plan gets when it adds NumReads without a length offset.
  counts[] <- as.integer(round(rowsum(num_reads, tx_gene)))
  reads_per_base <- num_reads / tx_effective
  tx_tpm <- sweep(reads_per_base, 2, colSums(reads_per_base), "/") * 1e6
  tpm <- rowsum(tx_tpm, tx_gene)
  dimnames(tpm) <- list(genes, meta$sample)
} else {
  for (i in seq_len(n_samples)) {
    mu <- size_factors[i] * 2^log_mu[, i]
    counts[, i] <- rnbinom(n_genes, mu = mu, size = 1 / dispersion)
  }
}

# ── Survival outcome (drawn after the counts, thus the counts stay) ──────────
if (PATTERN == "survival_n60") {
  # A 10-gene signature drives the hazard: a higher score, a shorter time. Ten
  # genes at this strength give a per-gene effect that a penalized Cox model
  # recovers at about 70 events; a 20-gene signature at strength 1.2 spread
  # the effect so thin that the lasso kept no gene at any lambda.
  sig <- sample(expressed, 10)
  # The score is depth-free: the counts are divided by the size factors before the log.
  corrected <- sweep(counts[sig, , drop = FALSE], 2, size_factors, "/")
  score <- colMeans(log2(corrected + 1))
  score <- (score - mean(score)) / sd(score)
  hazard <- exp(2.0 * score)
  time <- pmax(round(rexp(n_samples, rate = hazard / 24), 1), 0.1)
  censor <- round(runif(n_samples, 6, 36), 1)
  meta$time <- pmin(time, censor)
  meta$event <- as.integer(time <= censor)
  truth$planted_set[sig] <- "SURVIVAL_SIGNATURE"
}

# ── Gene lengths and TPM (drawn after the counts, thus the counts stay) ───────
# A Salmon pattern has its lengths and its TPM from the transcripts already.
if (!(PATTERN %in% SALMON_PATTERNS)) {
  gene_lengths <- pmax(200L, as.integer(round(exp(rnorm(n_genes, mean = log(2000), sd = 0.6)))))
  rpk <- counts / (gene_lengths / 1000)
  tpm <- sweep(rpk, 2, colSums(rpk), "/") * 1e6
}

# ── Write ─────────────────────────────────────────────────────────────────────
write.csv(data.frame(gene = genes, counts, check.names = FALSE), file.path(OUT, "counts.csv"), row.names = FALSE)
write.csv(data.frame(gene = genes, round(tpm, 4), check.names = FALSE), file.path(OUT, "tpm.csv"), row.names = FALSE)
write.csv(data.frame(gene = genes, round(log2(tpm + 1), 4), check.names = FALSE), file.path(OUT, "log_expr.csv"), row.names = FALSE)
write.csv(data.frame(gene = genes, length = gene_lengths), file.path(OUT, "gene_lengths.csv"), row.names = FALSE)
write.csv(meta, file.path(OUT, "metadata.csv"), row.names = FALSE)
write.csv(truth, file.path(OUT, "truth.csv"), row.names = FALSE)
if (PATTERN == "survival_n60") write.csv(data.frame(gene = genes[sig]), file.path(OUT, "signature_genes.csv"), row.names = FALSE)
if (PATTERN %in% SALMON_PATTERNS) {
  for (i in seq_len(n_samples)) {
    quant_dir <- file.path(OUT, "quant", meta$sample[i])
    dir.create(quant_dir, showWarnings = FALSE, recursive = TRUE)
    quant <- data.frame(
      Name = tx_name, Length = tx_length, EffectiveLength = sprintf("%.3f", tx_effective),
      TPM = sprintf("%.6f", tx_tpm[, i]), NumReads = sprintf("%.3f", num_reads[, i])
    )
    write.table(quant, file.path(quant_dir, "quant.sf"), sep = "\t", quote = FALSE, row.names = FALSE)
  }
  write.csv(data.frame(transcript = tx_name, gene = genes[tx_gene]), file.path(OUT, "tx2gene.csv"), row.names = FALSE)
  write.csv(
    data.frame(transcript = tx_name, gene = genes[tx_gene], length = tx_length, control_proportion = round(control_p, 4), treated_proportion = round(treated_p, 4)),
    file.path(OUT, "transcripts.csv"), row.names = FALSE
  )
}
# ── Quantifications from the gene counts (drawn after every other output) ─────
if (PATTERN %in% QUANT_PATTERNS) {
  n_tx <- sample(1:4, n_genes, replace = TRUE)
  tx_gene <- rep(seq_len(n_genes), n_tx)
  n_transcripts <- length(tx_gene)
  tx_name <- paste0(genes[tx_gene], "-T", sequence(n_tx))
  tx_length <- pmax(400L, as.integer(round(gene_lengths[tx_gene] * exp(rnorm(n_transcripts, sd = 0.5)))))
  tx_effective <- pmax(tx_length - 200L + 1L, 1L)
  base <- rgamma(n_transcripts, shape = 2)
  base_p <- base / rowsum(base, tx_gene)[tx_gene]
  for (i in seq_len(n_samples)) {
    usage <- rgamma(n_transcripts, shape = 50 * base_p)
    p <- usage / rowsum(usage, tx_gene)[tx_gene]
    num_reads <- counts[tx_gene, i] * p * runif(n_transcripts, 0.9, 1.1)
    reads_per_base <- num_reads / tx_effective
    tx_tpm <- reads_per_base / sum(reads_per_base) * 1e6
    quant_dir <- file.path(OUT, "quant", meta$sample[i])
    dir.create(quant_dir, showWarnings = FALSE, recursive = TRUE)
    quant <- data.frame(
      Name = tx_name, Length = tx_length, EffectiveLength = sprintf("%.3f", tx_effective),
      TPM = sprintf("%.6f", tx_tpm), NumReads = sprintf("%.3f", num_reads)
    )
    write.table(quant, file.path(quant_dir, "quant.sf"), sep = "\t", quote = FALSE, row.names = FALSE)
  }
  write.csv(data.frame(transcript = tx_name, gene = genes[tx_gene]), file.path(OUT, "tx2gene.csv"), row.names = FALSE)
}

record <- list(
  pattern = PATTERN, seed = SEED, n_genes = n_genes, n_samples = n_samples,
  n_de = sum(truth$de), planted_sets = unique(truth$planted_set[truth$planted_set != ""]),
  hallmark_genes = length(hallmark_genes), low_depth_sample = low_depth_sample, outlier_sample = outlier_sample,
  n_transcripts = n_transcripts, n_switch_genes = length(switch_genes),
  size_factors = as.list(setNames(round(size_factors, 3), meta$sample)),
  columns = colnames(meta)
)
writeLines(paste0('{', paste(sprintf('"%s": %s', names(record), vapply(record, function(v) {
  if (is.null(v) || (length(v) == 1 && is.na(v))) return("null")
  if (is.list(v)) return(paste0("{", paste(sprintf('"%s": %s', names(v), unlist(v)), collapse = ", "), "}"))
  if (is.character(v) && length(v) == 1 && !names(record)[match(list(v), record)] %in% "planted_sets") return(sprintf('"%s"', v))
  if (is.character(v)) return(paste0("[", paste(sprintf('"%s"', v), collapse = ", "), "]"))
  as.character(v)
}, "")), collapse = ", "), '}'), file.path(OUT, "sim.json"))
message("Simulated ", PATTERN, " seed ", SEED, ": ", n_genes, " genes x ", n_samples, " samples, ", sum(truth$de), " DE genes -> ", OUT)
