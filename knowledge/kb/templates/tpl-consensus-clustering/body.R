#!/usr/bin/env Rscript
# tpl-consensus-clustering — consensus clustering of the samples with
# ConsensusClusterPlus on the variance-stabilized top variable genes.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: the low count genes leave, the DESeq2 variance stabilizing
# transformation (blind to the design) gives the expression matrix, the top
# variable genes stay, and each gene is centered on its median. Consensus
# clustering (Monti et al. 2003) clusters many resampled subsets of the samples
# with hierarchical clustering on the stated distance and linkage, for k from 2
# to max_k, and the consensus matrix holds the share of the resamplings in
# which two samples fall into the same cluster (Wilkerson and Hayes 2010). The
# chosen k is the largest k whose relative change in the area under the
# consensus CDF is at least delta_area_min. The proportion of ambiguous
# clustering (PAC, Senbabaoglu et al. 2014) per k is the confirmation. The
# adjusted Rand index (Hubert and Arabie 1985), computed in base R, gives the
# agreement of the chosen clusters with the known condition.

suppressPackageStartupMessages({
  library(ConsensusClusterPlus)
  library(DESeq2)
  library(ggplot2)
  library(pheatmap)
  library(jsonlite)
})
options(stringsAsFactors = FALSE)

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH             <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH           <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN        <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN        <- {{condition_column}}  # [adaptable: condition_column]
MIN_COUNT               <- {{min_count}}  # [adaptable: min_count]
MIN_SAMPLES             <- {{min_samples}}  # [adaptable: min_samples] absent: the smallest group size, computed below
N_TOP_GENES             <- {{n_top_genes}}  # [adaptable: n_top_genes]
DISTANCE                <- {{distance}}  # [adaptable: distance]
LINKAGE                 <- {{linkage}}  # [adaptable: linkage]
CLUSTER_ALGORITHM       <- {{cluster_algorithm}}
MAX_K                   <- {{max_k}}  # [adaptable: max_k]
RESAMPLING_REPS         <- {{resampling_reps}}  # [adaptable: resampling_reps]
ITEM_SUBSAMPLE_SHARE    <- {{item_subsample_share}}  # [adaptable: item_subsample_share]
FEATURE_SUBSAMPLE_SHARE <- {{feature_subsample_share}}  # [adaptable: feature_subsample_share]
SEED                    <- {{seed}}  # [adaptable: seed]
DELTA_AREA_MIN          <- {{delta_area_min}}  # [adaptable: delta_area_min]
K_CRITERION             <- {{k_criterion}}
PAC_LOWER               <- {{pac_lower}}
PAC_UPPER               <- {{pac_upper}}
OUTPUT_PREFIX           <- {{output_prefix}}  # [adaptable: output_prefix]

# The breaks of the empirical CDF of the consensus values, the same grid as the
# CDF plot of ConsensusClusterPlus.
CDF_BREAKS <- seq(0, 1, by = 0.01)

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
counts_df <- read.csv(COUNTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- as.character(counts_df[[1]])
counts <- as.matrix(counts_df[, -1, drop = FALSE])
storage.mode(counts) <- "numeric"
rownames(counts) <- gene_ids
if (any(counts < 0, na.rm = TRUE) || any(abs(counts - round(counts)) > 1e-6, na.rm = TRUE)) {
  stop("The count matrix must hold non-negative integers. The script takes raw counts, not TPM or FPKM.")
}
counts <- round(counts)
if (any(duplicated(gene_ids))) stop("The count matrix holds a duplicated gene identifier; the clustering needs one row per gene.")

message("Reading the sample table from ", METADATA_PATH)
metadata <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (!SAMPLE_ID_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", SAMPLE_ID_COLUMN)
if (!CONDITION_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", CONDITION_COLUMN)
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(counts), rownames(metadata))
if (length(missing) > 0) stop("Samples in the counts but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(counts), , drop = FALSE]
metadata$condition <- factor(metadata[[CONDITION_COLUMN]])
n_samples <- ncol(counts)
if (n_samples < MAX_K + 1) stop("Only ", n_samples, " samples; the clustering needs more samples than max_k = ", MAX_K)
message("Samples: ", n_samples, "; genes: ", nrow(counts))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "))

# ── Filter and transform ──────────────────────────────────────────────────────
group_sizes <- table(metadata$condition)
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(group_sizes))
keep <- rowSums(counts >= MIN_COUNT) >= MIN_SAMPLES
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", MIN_SAMPLES, " samples: ", sum(keep), " of ", nrow(counts), " kept")
counts <- counts[keep, , drop = FALSE]
if (nrow(counts) < 2) stop("Only ", nrow(counts), " genes pass the count filter; the clustering needs more genes")

dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = ~ 1)
dds <- estimateSizeFactors(dds)
vsd <- vst(dds, blind = TRUE)
vst_matrix <- assay(vsd)

gene_variance <- apply(vst_matrix, 1, var)
n_clustered <- min(N_TOP_GENES, nrow(vst_matrix))
top_genes <- names(sort(gene_variance, decreasing = TRUE))[seq_len(n_clustered)]
expression <- vst_matrix[top_genes, , drop = FALSE]
expression <- sweep(expression, 1, apply(expression, 1, median))
message("Clustered genes: the top ", n_clustered, " by VST variance, each centered on its median")

# ── Consensus clustering ──────────────────────────────────────────────────────
# ConsensusClusterPlus writes its own figures into the title directory. They go
# to a temporary directory; the figures under figures/ come from the result.
plot_dir <- file.path(tempdir(), paste0(OUTPUT_PREFIX, "_consensus_cluster_plus"))
message("ConsensusClusterPlus: k 2..", MAX_K, ", ", RESAMPLING_REPS, " resamplings, ", ITEM_SUBSAMPLE_SHARE, " of the samples and ", FEATURE_SUBSAMPLE_SHARE, " of the genes per resampling, ", CLUSTER_ALGORITHM, " with ", DISTANCE, " distance and ", LINKAGE, " linkage, seed ", SEED)
consensus <- ConsensusClusterPlus(
  expression,
  maxK = MAX_K,
  reps = RESAMPLING_REPS,
  pItem = ITEM_SUBSAMPLE_SHARE,
  pFeature = FEATURE_SUBSAMPLE_SHARE,
  clusterAlg = CLUSTER_ALGORITHM,
  distance = DISTANCE,
  innerLinkage = LINKAGE,
  finalLinkage = LINKAGE,
  title = plot_dir,
  seed = SEED,
  plot = "png",
  verbose = FALSE
)
k_values <- seq(2, MAX_K)

# ── The choice of k ───────────────────────────────────────────────────────────
# The area under the empirical CDF of the consensus values (the lower triangle
# of the consensus matrix), the relative change in that area from k - 1 to k
# (the delta area, with the whole area at k = 2), and the PAC, the share of the
# consensus values inside the ambiguous range.
consensus_values <- function(k) {
  matrix_k <- consensus[[k]]$consensusMatrix
  matrix_k[lower.tri(matrix_k)]
}
cdf_of <- function(values) vapply(CDF_BREAKS, function(break_value) mean(values <= break_value), numeric(1))
cdf_table <- do.call(rbind, lapply(k_values, function(k) data.frame(k = k, consensus = CDF_BREAKS, cdf = cdf_of(consensus_values(k)))))
area <- vapply(k_values, function(k) {
  cdf <- cdf_table$cdf[cdf_table$k == k]
  sum(diff(CDF_BREAKS) * cdf[-1])
}, numeric(1))
delta_area <- c(area[1], diff(area) / area[-length(area)])
pac <- vapply(k_values, function(k) {
  values <- consensus_values(k)
  mean(values > PAC_LOWER & values < PAC_UPPER)
}, numeric(1))
names(area) <- names(delta_area) <- names(pac) <- paste0("k", k_values)

qualifies <- delta_area >= DELTA_AREA_MIN
CHOSEN_K <- max(k_values[qualifies])
chosen_k_rule <- paste0("the largest k with a relative change in the CDF area of at least ", DELTA_AREA_MIN)
PAC_K <- k_values[which.min(pac)]
pac_agrees <- PAC_K == CHOSEN_K
for (index in seq_along(k_values)) {
  message(sprintf("k = %d: CDF area %.3f, delta area %.3f, PAC %.3f", k_values[index], area[index], delta_area[index], pac[index]))
}
message("Chosen k: ", CHOSEN_K, " (", chosen_k_rule, ")")
message("PAC confirmation: the lowest PAC is at k = ", PAC_K, if (pac_agrees) ", which agrees with the chosen k" else ", which does not agree with the chosen k")
message("CAUTION: a consensus clustering returns clusters on random data; a cluster is a hypothesis until an independent variable or an external cohort supports it")

# ── Assignments and the agreement with the condition ──────────────────────────
adjusted_rand_index <- function(a, b) {
  contingency <- table(a, b)
  n <- sum(contingency)
  sum_cells <- sum(choose(contingency, 2))
  sum_rows <- sum(choose(rowSums(contingency), 2))
  sum_columns <- sum(choose(colSums(contingency), 2))
  expected <- sum_rows * sum_columns / choose(n, 2)
  max_index <- (sum_rows + sum_columns) / 2
  if (max_index == expected) return(0)
  (sum_cells - expected) / (max_index - expected)
}
classes <- lapply(k_values, function(k) as.integer(consensus[[k]]$consensusClass))
names(classes) <- paste0("k", k_values)
chosen_classes <- classes[[paste0("k", CHOSEN_K)]]
agreement <- adjusted_rand_index(chosen_classes, metadata$condition)
cluster_sizes <- table(chosen_classes)
message("Cluster sizes at k = ", CHOSEN_K, ": ", paste(sprintf("%s=%d", names(cluster_sizes), as.integer(cluster_sizes)), collapse = ", "))
cross_table <- table(cluster = chosen_classes, condition = metadata$condition)
message("Adjusted Rand index of the chosen clusters against ", CONDITION_COLUMN, ": ", sprintf("%.3f", agreement))
for (cluster in rownames(cross_table)) {
  message("Cluster ", cluster, ": ", paste(sprintf("%s=%d", colnames(cross_table), as.integer(cross_table[cluster, ])), collapse = ", "))
}

assignments <- data.frame(sample = colnames(expression), condition = as.character(metadata$condition), cluster = chosen_classes, stringsAsFactors = FALSE)
for (name in names(classes)) assignments[[name]] <- classes[[name]]
write.csv(assignments, out("assignments.csv"), row.names = FALSE)

# ── Item-consensus and cluster-consensus ──────────────────────────────────────
icl <- calcICL(consensus, title = plot_dir, plot = "png")
cluster_consensus <- data.frame(
  k = as.integer(icl$clusterConsensus[, "k"]),
  cluster = as.integer(icl$clusterConsensus[, "cluster"]),
  cluster_consensus = as.numeric(icl$clusterConsensus[, "clusterConsensus"]),
  stringsAsFactors = FALSE
)
cluster_consensus$n_samples <- mapply(function(k, cluster) sum(classes[[paste0("k", k)]] == cluster), cluster_consensus$k, cluster_consensus$cluster)
write.csv(cluster_consensus, out("cluster_consensus.csv"), row.names = FALSE)
item_consensus <- data.frame(
  k = as.integer(icl$itemConsensus$k),
  cluster = as.integer(icl$itemConsensus$cluster),
  sample = as.character(icl$itemConsensus$item),
  item_consensus = as.numeric(icl$itemConsensus$itemConsensus),
  stringsAsFactors = FALSE
)
item_consensus <- item_consensus[order(item_consensus$k, item_consensus$cluster, -item_consensus$item_consensus), ]
write.csv(item_consensus, out("item_consensus.csv"), row.names = FALSE)
chosen_cluster_consensus <- cluster_consensus[cluster_consensus$k == CHOSEN_K, ]
message("Cluster consensus at k = ", CHOSEN_K, ": ", paste(sprintf("%d=%.3f", chosen_cluster_consensus$cluster, chosen_cluster_consensus$cluster_consensus), collapse = ", "))

# ── Figures ───────────────────────────────────────────────────────────────────
consensus_matrix <- consensus[[CHOSEN_K]]$consensusMatrix
rownames(consensus_matrix) <- colnames(consensus_matrix) <- colnames(expression)
consensus_tree <- consensus[[CHOSEN_K]]$consensusTree
annotation <- data.frame(cluster = factor(chosen_classes), condition = metadata$condition, row.names = colnames(expression))
heatmap_title <- paste0("Consensus matrix, k = ", CHOSEN_K, " (", RESAMPLING_REPS, " resamplings, ", DISTANCE, ", ", LINKAGE, ")")
draw_consensus_heatmap <- function() {
  pheatmap(
    consensus_matrix,
    cluster_rows = consensus_tree, cluster_cols = consensus_tree,
    annotation_row = annotation, annotation_col = annotation,
    show_rownames = n_samples <= 40, show_colnames = n_samples <= 40,
    color = colorRampPalette(c("white", "#08306B"))(100), breaks = seq(0, 1, length.out = 101),
    main = heatmap_title
  )
}
png(fig("consensus_matrix.png"), width = 7, height = 6, units = "in", res = 300)
draw_consensus_heatmap()
invisible(dev.off())
pdf(fig("consensus_matrix.pdf"), width = 7, height = 6)
draw_consensus_heatmap()
invisible(dev.off())

cdf_table$k <- factor(cdf_table$k, levels = k_values)
cdf_plot <- ggplot(cdf_table, aes(x = consensus, y = cdf, color = k)) +
  geom_step(linewidth = 0.7) +
  scale_color_viridis_d(end = 0.9, name = "k") +
  xlab("Consensus index") + ylab("CDF") +
  ggtitle(paste0("Consensus CDF, chosen k = ", CHOSEN_K, " (delta area >= ", DELTA_AREA_MIN, ")")) +
  theme_classic()
save_figure(cdf_plot, "consensus_cdf")

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-consensus-clustering@1.0.0",
  method = "ConsensusClusterPlus consensus clustering",
  n_samples = n_samples,
  group_sizes = as.list(group_sizes),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(counts),
  n_genes_clustered = ncol(t(expression)),
  n_top_genes = N_TOP_GENES,
  transformation = "DESeq2 vst, blind, then median centering of each gene",
  cluster_algorithm = CLUSTER_ALGORITHM,
  distance = DISTANCE,
  linkage = LINKAGE,
  max_k = MAX_K,
  resampling_reps = RESAMPLING_REPS,
  item_subsample_share = ITEM_SUBSAMPLE_SHARE,
  feature_subsample_share = FEATURE_SUBSAMPLE_SHARE,
  seed = SEED,
  k_criterion = K_CRITERION,
  chosen_k = CHOSEN_K,
  chosen_k_rule = chosen_k_rule,
  delta_area_min = DELTA_AREA_MIN,
  cdf_area = as.list(round(area, 4)),
  delta_area = as.list(round(delta_area, 4)),
  pac = as.list(round(pac, 4)),
  pac_range = list(lower = PAC_LOWER, upper = PAC_UPPER),
  pac_k = PAC_K,
  pac_agrees_with_chosen_k = pac_agrees,
  cluster_sizes = as.list(setNames(as.integer(cluster_sizes), paste0("cluster_", names(cluster_sizes)))),
  cluster_consensus = as.list(setNames(round(chosen_cluster_consensus$cluster_consensus, 4), paste0("cluster_", chosen_cluster_consensus$cluster))),
  agreement = list(
    statistic = "adjusted_rand_index",
    condition_column = CONDITION_COLUMN,
    adjusted_rand_index = round(agreement, 4),
    cross_table = lapply(rownames(cross_table), function(cluster) as.list(setNames(as.integer(cross_table[cluster, ]), colnames(cross_table))))
  ),
  null_structure_caution = "a consensus clustering returns clusters on random data; a cluster is a hypothesis until an independent variable or an external cohort supports it",
  min_count = MIN_COUNT,
  min_samples = MIN_SAMPLES,
  versions = list(
    R = R.version.string,
    ConsensusClusterPlus = as.character(packageVersion("ConsensusClusterPlus")),
    DESeq2 = as.character(packageVersion("DESeq2"))
  )
)
names(summary_record$agreement$cross_table) <- paste0("cluster_", rownames(cross_table))
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("assignments.csv"))
