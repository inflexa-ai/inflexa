#!/usr/bin/env Rscript
# NCCTG lung cancer data (survival::lung): logistic regression predicting
# death within 365 days, empirical ROC and bootstrap AUC CI.

suppressPackageStartupMessages(library(survival))

out_dir <- file.path(commandArgs(trailingOnly = TRUE)[1], "derived", "survival")
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)

set.seed(20260925)

data(cancer, package = "survival")

## ---- landmark outcome at 365 days ----
# case (event=1): died at or before day 365 (status==2 & time<=365)
# control (event=0): known alive past day 365 (time>365, dead or censored later)
# dropped: censored at or before day 365 (status==1 & time<=365) - unknown outcome
d <- lung
d$event365 <- NA_integer_
d$event365[d$status == 2 & d$time <= 365] <- 1L
d$event365[d$time > 365] <- 0L
n_dropped <- sum(is.na(d$event365))
d <- d[!is.na(d$event365), ]

vars_full <- c("event365", "ph.ecog", "ph.karno", "age")
d_full <- d[, vars_full]
d_full <- d_full[complete.cases(d_full), ]

vars_ecog <- c("event365", "ph.ecog")
d_ecog <- d[, vars_ecog]
d_ecog <- d_ecog[complete.cases(d_ecog), ]

empirical_roc <- function(labels, scores) {
  # labels: 0/1 outcome, scores: predicted probability (higher = more likely event)
  ord <- order(-scores)
  labels <- labels[ord]
  scores <- scores[ord]
  P <- sum(labels == 1)
  N <- sum(labels == 0)
  tp <- cumsum(labels == 1)
  fp <- cumsum(labels == 0)
  # collapse to one row per distinct threshold (keep the last row at each
  # tied score, i.e. after all ties at that score are consumed)
  keep <- rev(!duplicated(rev(scores)))
  tpr <- tp[keep] / P
  fpr <- fp[keep] / N
  thr <- scores[keep]
  df <- data.frame(fpr = c(0, fpr, 1), tpr = c(0, tpr, 1), threshold = c(Inf, thr, -Inf))
  df <- df[order(df$fpr, df$tpr), ]
  df <- df[!duplicated(df[, c("fpr", "tpr")]), ]
  df
}

auc_trapezoid <- function(fpr, tpr) {
  o <- order(fpr, tpr)
  fpr <- fpr[o]; tpr <- tpr[o]
  sum(diff(fpr) * (head(tpr, -1) + tail(tpr, -1)) / 2)
}

fit_and_roc <- function(data, formula, model_name) {
  fit <- glm(formula, data = data, family = binomial())
  scores <- predict(fit, type = "response")
  roc_df <- empirical_roc(data$event365, scores)
  roc_df$model <- model_name
  auc <- auc_trapezoid(roc_df$fpr, roc_df$tpr)
  list(fit = fit, roc = roc_df, auc = auc, data = data, formula = formula)
}

m_full <- fit_and_roc(d_full, event365 ~ ph.ecog + ph.karno + age, "ECOG + Karnofsky + age")
m_ecog <- fit_and_roc(d_ecog, event365 ~ ph.ecog, "ECOG alone")

roc_out <- rbind(m_full$roc, m_ecog$roc)
roc_out <- roc_out[, c("fpr", "tpr", "threshold", "model")]
write.csv(roc_out, file.path(out_dir, "roc.csv"), row.names = FALSE)

## ---- bootstrap 95% CI on AUC (resample subjects, refit, recompute AUC) ----
bootstrap_auc_ci <- function(data, formula, B = 2000) {
  n <- nrow(data)
  aucs <- numeric(B)
  i <- 1L
  while (i <= B) {
    idx <- sample.int(n, n, replace = TRUE)
    bd <- data[idx, ]
    # need both classes present and the model to fit without separation issues
    if (length(unique(bd$event365)) < 2) next
    fit_b <- tryCatch(glm(formula, data = bd, family = binomial()), error = function(e) NULL)
    if (is.null(fit_b)) next
    scores_b <- predict(fit_b, type = "response")
    r_b <- empirical_roc(bd$event365, scores_b)
    aucs[i] <- auc_trapezoid(r_b$fpr, r_b$tpr)
    i <- i + 1L
  }
  quantile(aucs, c(0.025, 0.975))
}

ci_full <- bootstrap_auc_ci(d_full, event365 ~ ph.ecog + ph.karno + age)
ci_ecog <- bootstrap_auc_ci(d_ecog, event365 ~ ph.ecog)

roc_auc <- data.frame(
  model = c("ECOG + Karnofsky + age", "ECOG alone"),
  auc = c(m_full$auc, m_ecog$auc),
  auc_lower = c(ci_full[[1]], ci_ecog[[1]]),
  auc_upper = c(ci_full[[2]], ci_ecog[[2]])
)
write.csv(roc_auc, file.path(out_dir, "roc_auc.csv"), row.names = FALSE)

cat("n dropped (censored at/before 365d):", n_dropped, "\n")
cat("n full-model complete cases:", nrow(d_full), " events:", sum(d_full$event365), "\n")
cat("n ecog-model complete cases:", nrow(d_ecog), " events:", sum(d_ecog$event365), "\n")
cat("roc.csv rows:", nrow(roc_out), "\n")
cat("AUC full:", m_full$auc, " CI:", ci_full, "\n")
cat("AUC ecog:", m_ecog$auc, " CI:", ci_ecog, "\n")
