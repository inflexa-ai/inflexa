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
#   outlier_n5
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
N_GENES <- as.integer(option("--n-genes", "12000"))
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
n_genes <- length(genes)

# ── Design ────────────────────────────────────────────────────────────────────
make_design <- function(pattern) {
  if (pattern == "two_group_n3") {
    meta <- data.frame(condition = rep(c("control", "treated"), each = 3))
  } else if (pattern == "two_group_n6") {
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

if (PATTERN %in% c("two_group_n3", "two_group_n6", "batch_balanced_n6", "confounded_batch_n6", "no_replicates_1v1", "paired_n5", "outlier_n5")) {
  de_index <- sample_expressed(0.10)
  lfc <- effect_size(length(de_index))
  treated <- meta$condition == "treated"
  log_mu[de_index, treated] <- log_mu[de_index, treated] + lfc
  truth$de[de_index] <- 1L
  truth$lfc[de_index] <- lfc
  plant_hallmark("condition", "treated")
}
if (PATTERN == "paired_n5") {
  subject_effect <- matrix(rnorm(n_genes * 5, sd = 0.45), nrow = n_genes)
  for (i in seq_len(n_samples)) log_mu[, i] <- log_mu[, i] + subject_effect[, as.integer(factor(meta$subject))[i]]
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
for (i in seq_len(n_samples)) {
  mu <- size_factors[i] * 2^log_mu[, i]
  counts[, i] <- rnbinom(n_genes, mu = mu, size = 1 / dispersion)
}

# ── Gene lengths and TPM (drawn after the counts, thus the counts stay) ───────
gene_lengths <- pmax(200L, as.integer(round(exp(rnorm(n_genes, mean = log(2000), sd = 0.6)))))
rpk <- counts / (gene_lengths / 1000)
tpm <- sweep(rpk, 2, colSums(rpk), "/") * 1e6

# ── Write ─────────────────────────────────────────────────────────────────────
write.csv(data.frame(gene = genes, counts, check.names = FALSE), file.path(OUT, "counts.csv"), row.names = FALSE)
write.csv(data.frame(gene = genes, round(tpm, 4), check.names = FALSE), file.path(OUT, "tpm.csv"), row.names = FALSE)
write.csv(data.frame(gene = genes, length = gene_lengths), file.path(OUT, "gene_lengths.csv"), row.names = FALSE)
write.csv(meta, file.path(OUT, "metadata.csv"), row.names = FALSE)
write.csv(truth, file.path(OUT, "truth.csv"), row.names = FALSE)
record <- list(
  pattern = PATTERN, seed = SEED, n_genes = n_genes, n_samples = n_samples,
  n_de = sum(truth$de), planted_sets = unique(truth$planted_set[truth$planted_set != ""]),
  hallmark_genes = length(hallmark_genes), low_depth_sample = low_depth_sample, outlier_sample = outlier_sample,
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
