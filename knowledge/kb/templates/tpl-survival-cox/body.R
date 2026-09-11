#!/usr/bin/env Rscript
# tpl-survival-cox — Cox model of the time to event on a per-sample signature score.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: edgeR filterByExpr and library size scaling, log-CPM, then the
# per-sample signature score as the mean log-CPM of the signature genes,
# standardized to mean 0 and standard deviation 1. A Cox proportional hazards
# model of the time to event on the standardized score as a continuous term,
# with the clinical covariates in the same model (Cox 1972). The proportional
# hazards assumption is tested on the scaled Schoenfeld residuals (cox.zph).
# A Kaplan-Meier curve by the median split of the score is drawn for the
# picture only, with the log-rank p-value of the split as a secondary
# statistic. The inference stays in the continuous model.

suppressPackageStartupMessages({
  library(edgeR)
  library(survival)
  library(survminer)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH          <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH        <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN     <- {{sample_id_column}}  # [adaptable: sample_id_column]
TIME_COLUMN          <- {{time_column}}  # [adaptable: time_column]
EVENT_COLUMN         <- {{event_column}}  # [adaptable: event_column]
SIGNATURE_GENES      <- {{signature_genes}}  # [adaptable: signature_genes]
COVARIATES           <- {{covariates}}  # [adaptable: covariates] absent: the model holds the score only
MIN_COUNT            <- {{min_count}}  # [adaptable: min_count]
MIN_TOTAL_COUNT      <- {{min_total_count}}  # [adaptable: min_total_count]
NORMALIZATION_METHOD <- {{normalization_method}}  # [adaptable: normalization_method]
MIN_SIGNATURE_GENES  <- {{min_signature_genes}}  # [adaptable: min_signature_genes]
TIES                 <- {{ties}}
ALPHA                <- {{alpha}}
OUTPUT_PREFIX        <- {{output_prefix}}  # [adaptable: output_prefix]
PRIOR_COUNT          <- 2  # the prior count of the log-CPM (Law et al. 2018)
PH_TRANSFORM         <- "km"  # the time transform of the Schoenfeld test (Grambsch and Therneau 1994)

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_device_figure <- function(draw, name, width = 7, height = 6) {
  png(fig(paste0(name, ".png")), width = width, height = height, units = "in", res = 300)
  draw()
  dev.off()
  pdf(fig(paste0(name, ".pdf")), width = width, height = height)
  draw()
  dev.off()
}

SIGNATURE_GENES <- unique(as.character(SIGNATURE_GENES))
if (length(SIGNATURE_GENES) == 0) stop("The signature gene list is empty")
if (MIN_SIGNATURE_GENES < 1) stop("min_signature_genes must be at least 1")
if (!TIES %in% c("efron", "breslow", "exact")) stop("ties must be efron, breslow, or exact, not ", TIES)

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

# The outcome: a positive time and a 0/1 event. TRUE/FALSE is accepted as 1/0.
time_values <- suppressWarnings(as.numeric(metadata[[TIME_COLUMN]]))
if (anyNA(time_values)) stop("The time column ", TIME_COLUMN, " holds a missing or a non-numeric value")
if (any(time_values <= 0)) stop("The time column ", TIME_COLUMN, " holds a value of zero or less. A follow-up time must be positive.")
event_raw <- metadata[[EVENT_COLUMN]]
if (is.logical(event_raw)) event_raw <- as.integer(event_raw)
event_values <- suppressWarnings(as.integer(event_raw))
if (anyNA(event_values) || !all(event_values %in% c(0L, 1L))) stop("The event column ", EVENT_COLUMN, " must hold 0 (censored) or 1 (event) for every sample")
metadata$time <- time_values
metadata$event <- event_values
n_events <- sum(event_values)
if (n_events == 0) stop("The event column holds no event. A Cox model needs at least one event.")
if (n_events < 10) message("Caution: only ", n_events, " events. The hazard ratio of a small event count is unstable.")

# The covariates enter the model as fixed terms beside the score. A character
# covariate becomes a factor, a numeric covariate stays numeric.
COVARIATES <- as.character(COVARIATES)
if (anyDuplicated(COVARIATES) > 0) stop("The covariates list names a column two times: ", paste(COVARIATES[duplicated(COVARIATES)], collapse = ", "))
for (column in COVARIATES) {
  if (column %in% c(SAMPLE_ID_COLUMN, TIME_COLUMN, EVENT_COLUMN)) stop("The covariates list names ", column, ", which is the sample identifier, the time, or the event")
  if (column %in% c("signature_score", "time", "event")) stop("The covariates list names ", column, ", which is a reserved name of the model")
  if (!column %in% colnames(metadata)) stop("The covariates list names ", column, " but the sample table has no such column")
  if (anyNA(metadata[[column]])) stop("The covariate ", column, " has a missing value. Every sample needs a value for each covariate.")
  if (is.character(metadata[[column]]) || is.logical(metadata[[column]])) metadata[[column]] <- factor(metadata[[column]])
  if (is.factor(metadata[[column]]) && nlevels(metadata[[column]]) < 2) stop("The covariate ", column, " holds one level only, thus it adds nothing to the model.")
}
message("Samples: ", ncol(counts), "; genes: ", nrow(counts), "; events: ", n_events, " of ", ncol(counts))
if (length(COVARIATES) > 0) message("Covariates: ", paste(COVARIATES, collapse = ", "))

# ── Filter, scale, log-CPM ────────────────────────────────────────────────────
# The expression filter serves the scaling factors only: the library sizes and
# the TMM factors come from the expressed genes. The log-CPM then covers every
# gene of the count matrix, thus a fixed signature keeps each member that the
# count matrix holds.
dge <- DGEList(counts = counts)
keep <- filterByExpr(dge, min.count = MIN_COUNT, min.total.count = MIN_TOTAL_COUNT)
message("filterByExpr: ", sum(keep), " of ", nrow(dge), " genes expressed; the scaling factors come from these")
scaled <- calcNormFactors(dge[keep, , keep.lib.sizes = FALSE], method = NORMALIZATION_METHOD)
dge$samples$lib.size <- scaled$samples$lib.size
dge$samples$norm.factors <- scaled$samples$norm.factors
log_cpm <- cpm(dge, log = TRUE, prior.count = PRIOR_COUNT)

# ── Signature score ───────────────────────────────────────────────────────────
found <- intersect(SIGNATURE_GENES, rownames(log_cpm))
absent <- setdiff(SIGNATURE_GENES, rownames(log_cpm))
n_found_below_filter <- sum(!keep[found])
message("Signature genes: ", length(found), " of ", length(SIGNATURE_GENES), " in the count matrix; ", n_found_below_filter, " below the expression filter")
if (length(absent) > 0) message("Signature genes not in the count matrix: ", paste(absent, collapse = ", "))
if (length(found) < MIN_SIGNATURE_GENES) {
  stop("Only ", length(found), " signature genes are in the count matrix, fewer than min_signature_genes (", MIN_SIGNATURE_GENES, ")")
}
score_raw <- colMeans(log_cpm[found, , drop = FALSE])
score_sd <- sd(score_raw)
if (!is.finite(score_sd) || score_sd == 0) stop("The signature score is constant across the samples, thus the model has no term to fit")
metadata$signature_score <- (score_raw - mean(score_raw)) / score_sd
metadata$risk_group <- factor(ifelse(metadata$signature_score > median(metadata$signature_score), "high", "low"), levels = c("low", "high"))

# ── Cox model ─────────────────────────────────────────────────────────────────
model_terms <- c("signature_score", COVARIATES)
cox_formula <- as.formula(paste("Surv(time, event) ~", paste(model_terms, collapse = " + ")))
message("Cox model: ", deparse(cox_formula), "; ties: ", TIES)
fit <- coxph(cox_formula, data = metadata, ties = TIES)
if (any(is.na(coef(fit)))) {
  stop("A coefficient is not estimable: ", paste(names(coef(fit))[is.na(coef(fit))], collapse = ", "), ". A covariate is confounded with another term. Remove it.")
}
fit_summary <- summary(fit)
coefficients <- fit_summary$coefficients
intervals <- fit_summary$conf.int
cox_table <- data.frame(
  term = rownames(coefficients),
  hazard_ratio = unname(intervals[, "exp(coef)"]),
  ci_low = unname(intervals[, "lower .95"]),
  ci_high = unname(intervals[, "upper .95"]),
  pvalue = unname(coefficients[, "Pr(>|z|)"]),
  stringsAsFactors = FALSE
)
write.csv(cox_table, out("cox.csv"), row.names = FALSE)
signature_row <- cox_table[cox_table$term == "signature_score", ]
message(sprintf("Signature: hazard ratio per 1 SD = %.3f [%.3f, %.3f], p = %.3g", signature_row$hazard_ratio, signature_row$ci_low, signature_row$ci_high, signature_row$pvalue))
message(sprintf("Concordance: %.3f", fit_summary$concordance[1]))

# ── Proportional hazards test ─────────────────────────────────────────────────
ph_test <- cox.zph(fit, transform = PH_TRANSFORM)
ph_table <- as.data.frame(ph_test$table)
ph_table$term <- rownames(ph_table)
write.csv(ph_table[, c("term", "chisq", "df", "p")], out("ph_test.csv"), row.names = FALSE)
ph_signature_pvalue <- ph_table[ph_table$term == "signature_score", "p"]
ph_global_pvalue <- ph_table[ph_table$term == "GLOBAL", "p"]
message(sprintf("Proportional hazards test: signature p = %.3g, global p = %.3g", ph_signature_pvalue, ph_global_pvalue))
if (ph_signature_pvalue < ALPHA) {
  message("Caution: the proportional hazards assumption fails for the signature at p < ", ALPHA, ". Report a stratified model or a time-dependent effect, not the single hazard ratio.")
}

# ── Median split, for the figure only ─────────────────────────────────────────
split_fit <- survfit(Surv(time, event) ~ risk_group, data = metadata)
split_test <- survdiff(Surv(time, event) ~ risk_group, data = metadata)
logrank_pvalue <- pchisq(split_test$chisq, df = length(split_test$n) - 1, lower.tail = FALSE)
message(sprintf("Log-rank of the median split (secondary): p = %.3g", logrank_pvalue))

scores_table <- data.frame(
  sample = rownames(metadata),
  signature_score_raw = unname(score_raw),
  signature_score = metadata$signature_score,
  risk_group = as.character(metadata$risk_group),
  time = metadata$time,
  event = metadata$event,
  stringsAsFactors = FALSE
)
write.csv(scores_table, out("scores.csv"), row.names = FALSE)

# ── Figures ───────────────────────────────────────────────────────────────────
km_plot <- ggsurvplot(
  split_fit,
  data = metadata,
  conf.int = TRUE,
  risk.table = TRUE,
  legend.title = "Signature score",
  legend.labs = c("low (below the median)", "high (above the median)"),
  palette = c("#21908C", "#440154"),
  xlab = "Time",
  ylab = "Survival probability",
  title = sprintf("Kaplan-Meier by the median split of the score (log-rank p = %.2g)", logrank_pvalue),
  subtitle = sprintf("Cox: hazard ratio per 1 SD = %.2f [%.2f, %.2f], p = %.2g", signature_row$hazard_ratio, signature_row$ci_low, signature_row$ci_high, signature_row$pvalue),
  ggtheme = theme_classic()
)
save_device_figure(function() print(km_plot), "km")

schoenfeld_plot <- ggcoxzph(ph_test, var = "signature_score", point.size = 0.8)
save_device_figure(function() print(schoenfeld_plot), "schoenfeld", width = 6, height = 5)

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-survival-cox@1.0.0",
  method = "Cox proportional hazards on a standardized signature score",
  model = deparse(cox_formula),
  ties = TIES,
  n_samples = ncol(counts),
  n_events = n_events,
  n_censored = ncol(counts) - n_events,
  n_signature_genes_given = length(SIGNATURE_GENES),
  n_signature_genes_found = length(found),
  n_signature_genes_below_filter = n_found_below_filter,
  signature_genes_absent = as.list(absent),
  covariates = as.list(COVARIATES),
  signature_hazard_ratio = signature_row$hazard_ratio,
  signature_ci_low = signature_row$ci_low,
  signature_ci_high = signature_row$ci_high,
  signature_pvalue = signature_row$pvalue,
  concordance = unname(fit_summary$concordance[1]),
  ph_test_pvalue = ph_signature_pvalue,
  ph_global_pvalue = ph_global_pvalue,
  ph_transform = PH_TRANSFORM,
  ph_holds_at_alpha = ph_signature_pvalue >= ALPHA,
  logrank_median_split_pvalue = logrank_pvalue,
  median_split_sizes = as.list(table(metadata$risk_group)),
  alpha = ALPHA,
  min_count = MIN_COUNT,
  min_total_count = MIN_TOTAL_COUNT,
  normalization_method = NORMALIZATION_METHOD,
  prior_count = PRIOR_COUNT,
  n_genes_input = length(gene_ids),
  n_genes_expressed = sum(keep),
  versions = list(
    R = R.version.string,
    survival = as.character(packageVersion("survival")),
    survminer = as.character(packageVersion("survminer")),
    edgeR = as.character(packageVersion("edgeR"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("cox.csv"))
