#!/usr/bin/env Rscript
# tpl-glmnet-classifier — penalized logistic classifier of a sample class with nested cross-validation.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: log2 counts per million with a per-sample library size, thus the
# transform of a sample reads no other sample. An outer cross-validation,
# stratified by class, holds out each sample once. Inside each training fold
# the script fits the gene filter (the top variable genes of the training
# fold) and the scaling (the standardization of glmnet on the training fold),
# and an inner cross-validation selects the lambda of an elastic net or lasso
# logistic regression (Friedman et al. 2010). The held-out fold is predicted
# by a model that did not see it, thus the out-of-fold predictions give the
# performance: the ROC curve, the area under it with a DeLong confidence
# interval (Robin et al. 2011), the balanced accuracy, and the Brier score. A
# selection on every sample before the split makes the error optimistic
# (Ambroise and McLachlan 2002). A final model refitted on every sample gives
# the signature, with the selection frequency of each gene across the folds
# as the measure of its stability.

suppressPackageStartupMessages({
  library(glmnet)
  library(pROC)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH       <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH     <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN  <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN  <- {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL   <- {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL        <- {{test_level}}  # [adaptable: test_level]
MIN_COUNT         <- {{min_count}}  # [adaptable: min_count]
MIN_SAMPLES       <- {{min_samples}}  # [adaptable: min_samples] absent: the smallest class size, computed below
N_TOP_GENES       <- {{n_top_genes}}  # [adaptable: n_top_genes]
ELASTIC_NET_ALPHA <- {{elastic_net_alpha}}  # [adaptable: elastic_net_alpha] 1 is the lasso, 0 the ridge, between is the elastic net
LAMBDA_RULE       <- {{lambda_rule}}  # [adaptable: lambda_rule] lambda.1se or lambda.min
N_OUTER_FOLDS     <- {{n_outer_folds}}  # [adaptable: n_outer_folds]
N_INNER_FOLDS     <- {{n_inner_folds}}  # [adaptable: n_inner_folds]
SEED              <- {{seed}}  # [adaptable: seed]
OUTPUT_PREFIX     <- {{output_prefix}}  # [adaptable: output_prefix]
PRIOR_COUNT       <- 1  # the pseudocount of log2(CPM + 1)
PROBABILITY_CUT   <- 0.5  # the probability that calls the test level, for the balanced accuracy

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

if (!LAMBDA_RULE %in% c("lambda.1se", "lambda.min")) stop("lambda_rule must be lambda.1se or lambda.min, not ", LAMBDA_RULE)
if (ELASTIC_NET_ALPHA < 0 || ELASTIC_NET_ALPHA > 1) stop("elastic_net_alpha must be between 0 and 1")
if (N_OUTER_FOLDS < 3 || N_INNER_FOLDS < 3) stop("n_outer_folds and n_inner_folds must be at least 3")

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
if (!file.exists(COUNTS_PATH)) stop("The count matrix does not exist: ", COUNTS_PATH)
counts_df <- read.csv(COUNTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- as.character(counts_df[[1]])
counts <- as.matrix(counts_df[, -1, drop = FALSE])
storage.mode(counts) <- "numeric"
rownames(counts) <- gene_ids
if (any(counts < 0, na.rm = TRUE) || any(abs(counts - round(counts)) > 1e-6, na.rm = TRUE)) {
  stop("The count matrix must hold non-negative integers. The log-CPM starts from raw counts, not TPM or FPKM.")
}
counts <- round(counts)
if (any(duplicated(gene_ids))) stop("The count matrix holds duplicate gene identifiers")

message("Reading the sample table from ", METADATA_PATH)
if (!file.exists(METADATA_PATH)) stop("The sample table does not exist: ", METADATA_PATH)
metadata <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (!SAMPLE_ID_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", SAMPLE_ID_COLUMN)
if (!CONDITION_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", CONDITION_COLUMN)
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(counts), rownames(metadata))
if (length(missing) > 0) stop("Samples in the counts but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(counts), , drop = FALSE]
condition <- as.character(metadata[[CONDITION_COLUMN]])
if (!all(c(REFERENCE_LEVEL, TEST_LEVEL) %in% condition)) {
  stop("The condition column holds ", paste(unique(condition), collapse = ", "), " but not both ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
}
in_classes <- condition %in% c(REFERENCE_LEVEL, TEST_LEVEL)
if (!all(in_classes)) {
  message("Samples outside the two classes leave the classifier: ", sum(!in_classes))
  counts <- counts[, in_classes, drop = FALSE]
  condition <- condition[in_classes]
}
class_factor <- factor(condition, levels = c(REFERENCE_LEVEL, TEST_LEVEL))
class_sizes <- table(class_factor)
n_samples <- ncol(counts)
message("Samples: ", n_samples, "; genes: ", nrow(counts), "; classes: ", REFERENCE_LEVEL, "=", class_sizes[[REFERENCE_LEVEL]], ", ", TEST_LEVEL, "=", class_sizes[[TEST_LEVEL]])
if (min(class_sizes) < N_OUTER_FOLDS) stop("The smallest class holds ", min(class_sizes), " samples, fewer than the ", N_OUTER_FOLDS, " outer folds")
if (min(class_sizes) < 10) message("Caution: fewer than 10 samples in a class. The confidence interval of the area under the curve is wide, and the gene set is unstable across folds.")

# ── A per-sample transform: log2(CPM + 1) with the own library size ──────────
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(class_sizes))
keep <- rowSums(counts >= MIN_COUNT) >= MIN_SAMPLES
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", MIN_SAMPLES, " samples: ", sum(keep), " of ", nrow(counts), " kept (a count floor, not a variance filter)")
counts <- counts[keep, , drop = FALSE]
library_sizes <- colSums(counts)
if (any(library_sizes == 0)) stop("A sample has no counts after the filter")
log_cpm <- t(log2(t(counts) / library_sizes * 1e6 + PRIOR_COUNT))

# ── Folds, stratified by class ────────────────────────────────────────────────
set.seed(SEED)
outer_fold <- integer(n_samples)
for (level in levels(class_factor)) {
  members <- which(class_factor == level)
  outer_fold[members] <- sample(rep_len(seq_len(N_OUTER_FOLDS), length(members)))
}
message("Outer folds: ", N_OUTER_FOLDS, ", stratified by class, seed ", SEED, "; inner folds: ", N_INNER_FOLDS)

# ── The fit of one training fold: filter, scaling, and lambda inside the fold ─
fit_fold <- function(train) {
  train_matrix <- log_cpm[, train, drop = FALSE]
  gene_variance <- apply(train_matrix, 1, var)
  n_candidates <- min(N_TOP_GENES, sum(gene_variance > 0))
  candidates <- names(sort(gene_variance, decreasing = TRUE))[seq_len(n_candidates)]
  x <- t(train_matrix[candidates, , drop = FALSE])
  y <- class_factor[train]
  inner_folds <- min(N_INNER_FOLDS, min(table(y)))
  cv <- cv.glmnet(x, y, family = "binomial", alpha = ELASTIC_NET_ALPHA, nfolds = inner_folds, standardize = TRUE, type.measure = "deviance")
  list(cv = cv, candidates = candidates, lambda = cv[[LAMBDA_RULE]], inner_folds = inner_folds)
}

predict_fold <- function(fit, test) {
  x <- t(log_cpm[fit$candidates, test, drop = FALSE])
  as.numeric(predict(fit$cv, newx = x, s = fit$lambda, type = "response"))
}

# ── Nested cross-validation ───────────────────────────────────────────────────
probability <- rep(NA_real_, n_samples)
selected_per_fold <- list()
fold_records <- list()
for (fold in seq_len(N_OUTER_FOLDS)) {
  test <- which(outer_fold == fold)
  train <- setdiff(seq_len(n_samples), test)
  fit <- fit_fold(train)
  probability[test] <- predict_fold(fit, test)
  coefficients <- as.matrix(coef(fit$cv, s = fit$lambda))
  selected <- rownames(coefficients)[coefficients[, 1] != 0 & rownames(coefficients) != "(Intercept)"]
  selected_per_fold[[fold]] <- selected
  fold_records[[fold]] <- list(fold = fold, n_train = length(train), n_test = length(test), n_candidates = length(fit$candidates), lambda = fit$lambda, inner_folds = fit$inner_folds, n_selected = length(selected))
  message(sprintf("Outer fold %d: %d train, %d test, %d candidates, inner folds %d, lambda %.4g, %d genes selected", fold, length(train), length(test), length(fit$candidates), fit$inner_folds, fit$lambda, length(selected)))
}
predictions <- data.frame(
  sample = colnames(counts),
  class = as.character(class_factor),
  outer_fold = outer_fold,
  probability = probability,
  predicted = ifelse(probability >= PROBABILITY_CUT, TEST_LEVEL, REFERENCE_LEVEL),
  stringsAsFactors = FALSE
)
write.csv(predictions, out("predictions.csv"), row.names = FALSE)

# ── Performance from the out-of-fold predictions ──────────────────────────────
roc_curve <- roc(response = class_factor, predictor = probability, levels = c(REFERENCE_LEVEL, TEST_LEVEL), direction = "<", quiet = TRUE)
auc_value <- as.numeric(auc(roc_curve))
auc_ci <- as.numeric(ci.auc(roc_curve, method = "delong"))
truth_test <- class_factor == TEST_LEVEL
called_test <- probability >= PROBABILITY_CUT
sensitivity <- sum(called_test & truth_test) / sum(truth_test)
specificity <- sum(!called_test & !truth_test) / sum(!truth_test)
balanced_accuracy <- (sensitivity + specificity) / 2
brier <- mean((probability - as.numeric(truth_test))^2)
message(sprintf("Out-of-fold AUC = %.3f [%.3f, %.3f] (DeLong 95%%); balanced accuracy %.3f; Brier score %.3f", auc_value, auc_ci[1], auc_ci[3], balanced_accuracy, brier))

# ── The final model on every sample, with the selection frequency ────────────
final <- fit_fold(seq_len(n_samples))
final_coefficients <- as.matrix(coef(final$cv, s = final$lambda))
selection_counts <- table(unlist(selected_per_fold))
coefficient_table <- data.frame(
  gene = rownames(final_coefficients),
  coefficient = final_coefficients[, 1],
  stringsAsFactors = FALSE
)
coefficient_table <- coefficient_table[coefficient_table$gene != "(Intercept)", ]
coefficient_table$selection_frequency <- as.numeric(selection_counts[coefficient_table$gene])
coefficient_table$selection_frequency[is.na(coefficient_table$selection_frequency)] <- 0
coefficient_table$selection_frequency <- coefficient_table$selection_frequency / N_OUTER_FOLDS
coefficient_table <- coefficient_table[coefficient_table$coefficient != 0 | coefficient_table$selection_frequency > 0, ]
coefficient_table <- coefficient_table[order(-abs(coefficient_table$coefficient), -coefficient_table$selection_frequency), ]
write.csv(coefficient_table, out("coefficients.csv"), row.names = FALSE)
final_genes <- coefficient_table$gene[coefficient_table$coefficient != 0]
message("Final model: ", length(final_genes), " genes with a nonzero coefficient; ", sum(coefficient_table$selection_frequency == 1), " selected in every fold")

# ── Figures ───────────────────────────────────────────────────────────────────
roc_df <- data.frame(fpr = 1 - roc_curve$specificities, tpr = roc_curve$sensitivities)
roc_df <- roc_df[order(roc_df$fpr, roc_df$tpr), ]
roc_plot <- ggplot(roc_df, aes(x = fpr, y = tpr)) +
  geom_abline(slope = 1, intercept = 0, linetype = "dashed", color = "grey60") +
  geom_path(color = "#21908C", linewidth = 1) +
  coord_equal() +
  xlab("1 - specificity") + ylab("Sensitivity") +
  ggtitle(sprintf("Out-of-fold ROC: AUC = %.3f [%.3f, %.3f]", auc_value, auc_ci[1], auc_ci[3])) +
  theme_classic()
save_figure(roc_plot, "roc", width = 5, height = 5)

top_coefficients <- head(coefficient_table[coefficient_table$coefficient != 0, ], 30)
if (nrow(top_coefficients) > 0) {
  top_coefficients$gene <- factor(top_coefficients$gene, levels = top_coefficients$gene[order(top_coefficients$coefficient)])
  coefficient_plot <- ggplot(top_coefficients, aes(x = gene, y = coefficient, fill = selection_frequency)) +
    geom_col() +
    coord_flip() +
    scale_fill_viridis_c(limits = c(0, 1), name = "Selection\nfrequency") +
    xlab(NULL) + ylab(paste0("Coefficient of the final model (", TEST_LEVEL, " vs ", REFERENCE_LEVEL, ")")) +
    ggtitle("Signature genes of the final model") +
    theme_classic()
  save_figure(coefficient_plot, "coefficients", width = 6, height = 6)
}

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-glmnet-classifier@1.0.0",
  method = "Penalized logistic regression with glmnet, nested cross-validation, and a pROC curve",
  classes = list(reference = REFERENCE_LEVEL, test = TEST_LEVEL),
  class_sizes = as.list(class_sizes),
  n_samples = n_samples,
  n_genes_input = length(gene_ids),
  n_genes_after_count_floor = nrow(counts),
  transform = "log2(CPM + 1) with the own library size of each sample",
  preprocessing_scope = "the variance filter and the scaling are fitted inside each training fold",
  n_top_genes = N_TOP_GENES,
  penalty = if (ELASTIC_NET_ALPHA == 1) "lasso" else if (ELASTIC_NET_ALPHA == 0) "ridge" else "elastic_net",
  elastic_net_alpha = ELASTIC_NET_ALPHA,
  lambda_rule = LAMBDA_RULE,
  n_outer_folds = N_OUTER_FOLDS,
  n_inner_folds = N_INNER_FOLDS,
  seed = SEED,
  folds = fold_records,
  auc = auc_value,
  auc_ci_low = auc_ci[1],
  auc_ci_high = auc_ci[3],
  auc_ci_method = "DeLong",
  balanced_accuracy = balanced_accuracy,
  sensitivity = sensitivity,
  specificity = specificity,
  brier_score = brier,
  probability_cut = PROBABILITY_CUT,
  final_model = list(lambda = final$lambda, n_candidates = length(final$candidates), n_nonzero = length(final_genes), genes = as.list(final_genes)),
  n_genes_selected_in_every_fold = sum(coefficient_table$selection_frequency == 1),
  validation = "internal: the performance comes from the out-of-fold predictions; an external cohort with the same library type and quantifier must validate the classifier before any use, and a batch or depth signal that separates the classes inflates the accuracy",
  min_count = MIN_COUNT,
  min_samples = MIN_SAMPLES,
  versions = list(
    R = R.version.string,
    glmnet = as.character(packageVersion("glmnet")),
    pROC = as.character(packageVersion("pROC"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("predictions.csv"))
