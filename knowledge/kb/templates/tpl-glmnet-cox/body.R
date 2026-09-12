#!/usr/bin/env Rscript
# tpl-glmnet-cox — penalized Cox regression of the time to event on the expression of many genes.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: edgeR filterByExpr and library size scaling, log-CPM, every
# expressed gene as a candidate (or the top variable genes, a filter that
# reads no outcome), then an
# elastic net or lasso penalty on the Cox partial likelihood over the
# candidates, fitted along the regularization path by coordinate descent
# (Simon et al. 2011). A cross-validation on the partial-likelihood deviance
# selects the lambda by the stated rule, and the genes with a nonzero
# coefficient at that lambda form the signature. A clinical covariate enters
# the model without a penalty. The linear predictor of a sample is its risk
# score. The concordance of that score on the same samples is optimistic,
# thus the summary states it as internal and asks for an external cohort.

suppressPackageStartupMessages({
  library(edgeR)
  library(glmnet)
  library(survival)
  library(survminer)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH          <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH        <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN     <- {{sample_id_column}}  # [adaptable: sample_id_column]
TIME_COLUMN          <- {{time_column}}  # [adaptable: time_column]
EVENT_COLUMN         <- {{event_column}}  # [adaptable: event_column]
COVARIATES           <- {{covariates}}  # [adaptable: covariates] absent: the model holds the genes only
MIN_COUNT            <- {{min_count}}  # [adaptable: min_count]
MIN_TOTAL_COUNT      <- {{min_total_count}}  # [adaptable: min_total_count]
NORMALIZATION_METHOD <- {{normalization_method}}  # [adaptable: normalization_method]
N_TOP_GENES          <- {{n_top_genes}}  # [adaptable: n_top_genes] absent: every expressed gene is a candidate
ELASTIC_NET_ALPHA    <- {{elastic_net_alpha}}  # [adaptable: elastic_net_alpha] 1 is the lasso, 0 the ridge, between is the elastic net
LAMBDA_RULE          <- {{lambda_rule}}  # [adaptable: lambda_rule] lambda.min or lambda.1se
N_FOLDS              <- {{n_folds}}  # [adaptable: n_folds]
SEED                 <- {{seed}}  # [adaptable: seed]
OUTPUT_PREFIX        <- {{output_prefix}}  # [adaptable: output_prefix]
PRIOR_COUNT          <- 2  # the prior count of the log-CPM (Law et al. 2018)
MIN_EVENTS           <- 10  # below this event count the fit is unstable, and the log carries a caution

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

save_device_figure <- function(draw, name, width = 7, height = 6) {
  png(fig(paste0(name, ".png")), width = width, height = height, units = "in", res = 300)
  draw()
  dev.off()
  pdf(fig(paste0(name, ".pdf")), width = width, height = height)
  draw()
  dev.off()
}

if (!LAMBDA_RULE %in% c("lambda.1se", "lambda.min")) stop("lambda_rule must be lambda.1se or lambda.min, not ", LAMBDA_RULE)
if (ELASTIC_NET_ALPHA < 0 || ELASTIC_NET_ALPHA > 1) stop("elastic_net_alpha must be between 0 and 1")
if (N_FOLDS < 3) stop("n_folds must be at least 3")

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
for (column in c(SAMPLE_ID_COLUMN, TIME_COLUMN, EVENT_COLUMN)) {
  if (!column %in% colnames(metadata)) stop("The sample table has no column ", column)
}
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(counts), rownames(metadata))
if (length(missing) > 0) stop("Samples in the counts but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(counts), , drop = FALSE]

time_values <- suppressWarnings(as.numeric(metadata[[TIME_COLUMN]]))
if (anyNA(time_values)) stop("The time column ", TIME_COLUMN, " holds a missing or a non-numeric value")
if (any(time_values <= 0)) stop("The time column ", TIME_COLUMN, " holds a value of zero or less. A follow-up time must be positive.")
event_raw <- metadata[[EVENT_COLUMN]]
if (is.logical(event_raw)) event_raw <- as.integer(event_raw)
event_values <- suppressWarnings(as.integer(event_raw))
if (anyNA(event_values) || !all(event_values %in% c(0L, 1L))) stop("The event column ", EVENT_COLUMN, " must hold 0 (censored) or 1 (event) for every sample")
n_events <- sum(event_values)
if (n_events == 0) stop("The event column holds no event. A Cox model needs at least one event.")
if (n_events < MIN_EVENTS) message("Caution: only ", n_events, " events. A penalized signature on so few events is unstable.")
outcome <- Surv(time_values, event_values)

COVARIATES <- as.character(COVARIATES)
if (anyDuplicated(COVARIATES) > 0) stop("The covariates list names a column two times: ", paste(COVARIATES[duplicated(COVARIATES)], collapse = ", "))
covariate_matrix <- NULL
if (length(COVARIATES) > 0) {
  for (column in COVARIATES) {
    if (column %in% c(SAMPLE_ID_COLUMN, TIME_COLUMN, EVENT_COLUMN)) stop("The covariates list names ", column, ", which is the sample identifier, the time, or the event")
    if (!column %in% colnames(metadata)) stop("The covariates list names ", column, " but the sample table has no such column")
    if (anyNA(metadata[[column]])) stop("The covariate ", column, " has a missing value. Every sample needs a value for each covariate.")
    if (is.character(metadata[[column]]) || is.logical(metadata[[column]])) metadata[[column]] <- factor(metadata[[column]])
    if (is.factor(metadata[[column]]) && nlevels(metadata[[column]]) < 2) stop("The covariate ", column, " holds one level only, thus it adds nothing to the model.")
  }
  covariate_formula <- as.formula(paste("~", paste(COVARIATES, collapse = " + ")))
  covariate_matrix <- model.matrix(covariate_formula, data = metadata)[, -1, drop = FALSE]
}
message("Samples: ", ncol(counts), "; genes: ", nrow(counts), "; events: ", n_events, " of ", ncol(counts))
if (length(COVARIATES) > 0) message("Covariates without a penalty: ", paste(COVARIATES, collapse = ", "))

# ── Filter, scale, log-CPM, candidate genes ───────────────────────────────────
dge <- DGEList(counts = counts)
keep <- filterByExpr(dge, min.count = MIN_COUNT, min.total.count = MIN_TOTAL_COUNT)
message("filterByExpr: ", sum(keep), " of ", nrow(dge), " genes expressed")
dge <- calcNormFactors(dge[keep, , keep.lib.sizes = FALSE], method = NORMALIZATION_METHOD)
log_cpm <- cpm(dge, log = TRUE, prior.count = PRIOR_COUNT)
gene_variance <- apply(log_cpm, 1, var)
if (is.na(N_TOP_GENES)) {
  candidates <- rownames(log_cpm)[gene_variance > 0]
  candidate_filter <- "every expressed gene with a non-zero variance"
  message("Candidate genes: every expressed gene (", length(candidates), "); the penalty does the selection")
} else {
  n_candidates <- min(N_TOP_GENES, nrow(log_cpm))
  candidates <- names(sort(gene_variance, decreasing = TRUE))[seq_len(n_candidates)]
  candidate_filter <- paste0("top ", n_candidates, " genes by the variance of the log-CPM over every sample, a filter that reads no outcome")
  message("Candidate genes: the top ", n_candidates, " by log-CPM variance, a filter that reads no outcome")
}
n_candidates <- length(candidates)
gene_matrix <- t(log_cpm[candidates, , drop = FALSE])

predictors <- if (is.null(covariate_matrix)) gene_matrix else cbind(gene_matrix, covariate_matrix)
penalty_factor <- c(rep(1, ncol(gene_matrix)), rep(0, if (is.null(covariate_matrix)) 0 else ncol(covariate_matrix)))

# ── Cross-validated penalized Cox ─────────────────────────────────────────────
set.seed(SEED)
n_folds <- min(N_FOLDS, ncol(counts))
message("cv.glmnet: Cox family, elastic net alpha ", ELASTIC_NET_ALPHA, ", ", n_folds, " folds, seed ", SEED)
cv_fit <- cv.glmnet(predictors, outcome, family = "cox", alpha = ELASTIC_NET_ALPHA, nfolds = n_folds, penalty.factor = penalty_factor, standardize = TRUE)
lambda_used <- cv_fit[[LAMBDA_RULE]]
cv_index <- which(cv_fit$lambda == lambda_used)
cv_table <- data.frame(
  lambda = cv_fit$lambda,
  cv_deviance = cv_fit$cvm,
  cv_deviance_sd = cv_fit$cvsd,
  n_nonzero = cv_fit$nzero
)
write.csv(cv_table, out("cv_path.csv"), row.names = FALSE)
message(sprintf("lambda.min = %.4g, lambda.1se = %.4g; %s selected: lambda = %.4g, cross-validated deviance %.3f", cv_fit$lambda.min, cv_fit$lambda.1se, LAMBDA_RULE, lambda_used, cv_fit$cvm[cv_index]))

coefficients <- as.matrix(coef(cv_fit, s = lambda_used))
coefficient_table <- data.frame(
  term = rownames(coefficients),
  coefficient = coefficients[, 1],
  penalized = penalty_factor == 1,
  stringsAsFactors = FALSE
)
coefficient_table$nonzero <- coefficient_table$coefficient != 0
signature <- coefficient_table[coefficient_table$penalized & coefficient_table$nonzero, ]
signature <- signature[order(-abs(signature$coefficient)), ]
coefficient_table <- coefficient_table[order(!coefficient_table$nonzero, -abs(coefficient_table$coefficient)), ]
write.csv(coefficient_table, out("coefficients.csv"), row.names = FALSE)
n_nonzero <- nrow(signature)
message("Signature: ", n_nonzero, " genes with a nonzero coefficient at the selected lambda")
if (n_nonzero == 0) message("Caution: the penalty removes every gene. The expression carries no signal that the cross-validation keeps, or the lambda rule is too strict for this cohort.")

# ── Risk score ────────────────────────────────────────────────────────────────
risk_score <- as.numeric(predict(cv_fit, newx = predictors, s = lambda_used, type = "link"))
# A higher risk score predicts a shorter time, thus the concordance takes the reversed direction, as coxph reports it.
concordance_internal <- if (sd(risk_score) > 0) concordance(outcome ~ risk_score, reverse = TRUE)$concordance else NA_real_
risk_group <- factor(ifelse(risk_score > median(risk_score), "high", "low"), levels = c("low", "high"))
scores_table <- data.frame(
  sample = colnames(counts),
  risk_score = risk_score,
  risk_group = as.character(risk_group),
  time = time_values,
  event = event_values,
  stringsAsFactors = FALSE
)
write.csv(scores_table, out("risk_scores.csv"), row.names = FALSE)
if (is.finite(concordance_internal)) message(sprintf("Internal concordance of the risk score: %.3f (on the samples that trained the model, thus optimistic)", concordance_internal))

# ── Figures ───────────────────────────────────────────────────────────────────
cv_df <- cv_table
cv_df$selected <- cv_df$lambda == lambda_used
cv_plot <- ggplot(cv_df, aes(x = log(lambda), y = cv_deviance)) +
  geom_errorbar(aes(ymin = cv_deviance - cv_deviance_sd, ymax = cv_deviance + cv_deviance_sd), color = "grey70", width = 0.05) +
  geom_point(aes(color = selected), size = 1.5) +
  geom_vline(xintercept = log(cv_fit$lambda.min), linetype = "dashed") +
  geom_vline(xintercept = log(cv_fit$lambda.1se), linetype = "dotted") +
  scale_color_manual(values = c(`FALSE` = "grey30", `TRUE` = "#B2182B"), name = LAMBDA_RULE) +
  xlab("log(lambda)") + ylab("Cross-validated partial-likelihood deviance") +
  ggtitle(paste0("cv.glmnet Cox path (alpha ", ELASTIC_NET_ALPHA, "): dashed lambda.min, dotted lambda.1se")) +
  theme_classic()
save_figure(cv_plot, "cv_curve")

split_data <- data.frame(time = time_values, event = event_values, risk_group = risk_group)
if (nlevels(droplevels(risk_group)) == 2 && sd(risk_score) > 0) {
  split_fit <- survfit(Surv(time, event) ~ risk_group, data = split_data)
  split_test <- survdiff(Surv(time, event) ~ risk_group, data = split_data)
  logrank_pvalue <- pchisq(split_test$chisq, df = 1, lower.tail = FALSE)
  km_plot <- ggsurvplot(
    split_fit,
    data = split_data,
    conf.int = TRUE,
    risk.table = TRUE,
    legend.title = "Risk score",
    legend.labs = c("low (below the median)", "high (above the median)"),
    palette = c("#21908C", "#440154"),
    xlab = "Time",
    ylab = "Survival probability",
    title = sprintf("Kaplan-Meier by the median split of the internal risk score (log-rank p = %.2g)", logrank_pvalue),
    subtitle = "The score was fitted on these samples: the separation is optimistic and not a validation",
    ggtheme = theme_classic()
  )
  save_device_figure(function() print(km_plot), "km")
} else {
  logrank_pvalue <- NA_real_
  message("The risk score is constant; no Kaplan-Meier split")
}

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-glmnet-cox@1.0.0",
  method = "Penalized Cox regression with glmnet and a cross-validated lambda",
  penalty = if (ELASTIC_NET_ALPHA == 1) "lasso" else if (ELASTIC_NET_ALPHA == 0) "ridge" else "elastic_net",
  elastic_net_alpha = ELASTIC_NET_ALPHA,
  lambda_rule = LAMBDA_RULE,
  lambda_used = lambda_used,
  lambda_min = cv_fit$lambda.min,
  lambda_1se = cv_fit$lambda.1se,
  cv_deviance_at_lambda = cv_fit$cvm[cv_index],
  n_folds = n_folds,
  seed = SEED,
  n_samples = ncol(counts),
  n_events = n_events,
  n_censored = ncol(counts) - n_events,
  n_genes_input = length(gene_ids),
  n_genes_expressed = sum(keep),
  n_candidate_genes = n_candidates,
  candidate_filter = candidate_filter,
  covariates = as.list(COVARIATES),
  n_nonzero = n_nonzero,
  signature_genes = as.list(signature$term),
  signature_coefficients = as.list(round(signature$coefficient, 5)),
  concordance_internal = concordance_internal,
  logrank_median_split_pvalue = logrank_pvalue,
  validation = "internal only: the concordance and the split come from the samples that trained the model; an external cohort with the same library type and quantifier must validate the signature before any use",
  min_count = MIN_COUNT,
  min_total_count = MIN_TOTAL_COUNT,
  normalization_method = NORMALIZATION_METHOD,
  prior_count = PRIOR_COUNT,
  versions = list(
    R = R.version.string,
    glmnet = as.character(packageVersion("glmnet")),
    survival = as.character(packageVersion("survival")),
    edgeR = as.character(packageVersion("edgeR"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("coefficients.csv"))
