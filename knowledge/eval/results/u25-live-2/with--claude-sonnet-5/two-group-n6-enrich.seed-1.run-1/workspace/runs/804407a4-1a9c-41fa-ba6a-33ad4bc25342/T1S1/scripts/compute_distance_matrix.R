#!/usr/bin/env Rscript
# compute_distance_matrix.R
# Persist the Euclidean sample-distance matrix (on VST-blind values) as a CSV
# alongside the heatmap figure already produced by tpl-qc-eda.R, so the exact
# distances behind the heatmap are available as a tabular artifact (not just
# a picture) for the QC report.

suppressPackageStartupMessages({
  library(jsonlite)
})

VST_PATH <- "output/qc_vst.csv"
OUT_PATH <- "output/qc_sample_distances.csv"

message("Reading VST matrix from ", VST_PATH)
vst_df <- read.csv(VST_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- vst_df[[1]]
vst_mat <- as.matrix(vst_df[, -1, drop = FALSE])
rownames(vst_mat) <- gene_ids

distances <- dist(t(vst_mat))
distance_matrix <- as.matrix(distances)

write.csv(data.frame(sample = rownames(distance_matrix), distance_matrix, check.names = FALSE),
          OUT_PATH, row.names = FALSE)

# Also report, per sample, mean distance to the rest of the cohort and mean
# distance to same-condition samples vs the other condition - useful to
# describe whether the low-depth sample sits apart from its own group.
metadata <- read.csv("/eval-u25-live-2-with-two-group-n6-enrich-s1-1/data/inputs/local/metadata.csv",
                      check.names = FALSE, stringsAsFactors = FALSE)
rownames(metadata) <- metadata$sample
metadata <- metadata[colnames(distance_matrix), , drop = FALSE]

mean_dist_overall <- sapply(colnames(distance_matrix), function(s) {
  mean(distance_matrix[s, colnames(distance_matrix) != s])
})
mean_dist_same_condition <- sapply(colnames(distance_matrix), function(s) {
  cond <- metadata[s, "condition"]
  same <- rownames(metadata)[metadata$condition == cond & rownames(metadata) != s]
  mean(distance_matrix[s, same])
})
mean_dist_other_condition <- sapply(colnames(distance_matrix), function(s) {
  cond <- metadata[s, "condition"]
  other <- rownames(metadata)[metadata$condition != cond]
  mean(distance_matrix[s, other])
})

distance_summary <- data.frame(
  sample = colnames(distance_matrix),
  condition = metadata[colnames(distance_matrix), "condition"],
  mean_distance_to_all_others = round(mean_dist_overall, 2),
  mean_distance_to_same_condition = round(mean_dist_same_condition, 2),
  mean_distance_to_other_condition = round(mean_dist_other_condition, 2),
  stringsAsFactors = FALSE
)
write.csv(distance_summary, "output/qc_distance_summary.csv", row.names = FALSE)
message("Wrote ", OUT_PATH, " and output/qc_distance_summary.csv")
print(distance_summary)
