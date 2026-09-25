#!/usr/bin/env Rscript
# NCCTG lung cancer data (survival::lung) -> KM curves, risk table, summary,
# log-rank test, and a Cox proportional-hazards forest table.
# Source: R `survival` package (Loprinzi et al. 1994, J Clin Oncol 12(3):601-7).

suppressPackageStartupMessages(library(survival))

out_dir <- "gallery-data/derived/survival"
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)

data(cancer, package = "survival")
lung$sex_label <- factor(lung$sex, levels = c(1, 2), labels = c("Male", "Female"))

## ---- KM fit by sex, log-log CI (survfit default conf.type = "log-log") ----
fit <- survfit(Surv(time, status) ~ sex_label, data = lung, conf.type = "log-log")
sf <- summary(fit, censored = TRUE)

km_curve <- data.frame(
  strata = sub("^sex_label=", "", as.character(sf$strata)),
  time = sf$time,
  surv = sf$surv,
  lower = sf$lower,
  upper = sf$upper,
  n_risk = sf$n.risk,
  n_event = sf$n.event,
  n_censor = sf$n.censor
)

# Prepend a time-0 row (surv = 1, full risk set, no events/censors) per stratum.
strata_levels <- levels(lung$sex_label)
n_at_start <- table(lung$sex_label)
time0 <- data.frame(
  strata = strata_levels,
  time = 0,
  surv = 1,
  lower = 1,
  upper = 1,
  n_risk = as.integer(n_at_start[strata_levels]),
  n_event = 0,
  n_censor = 0
)
km_curve <- rbind(time0, km_curve)
km_curve <- km_curve[order(km_curve$strata, km_curve$time), ]
write.csv(km_curve, file.path(out_dir, "km_curve.csv"), row.names = FALSE)

## ---- risk table at fixed times 0..1000 by 100 ----
risk_times <- seq(0, 1000, by = 100)
rt_summary <- summary(fit, times = risk_times, extend = TRUE)
km_risk_table <- data.frame(
  strata = sub("^sex_label=", "", as.character(rt_summary$strata)),
  time = rt_summary$time,
  n_risk = rt_summary$n.risk
)
km_risk_table <- km_risk_table[order(km_risk_table$strata, km_risk_table$time), ]
write.csv(km_risk_table, file.path(out_dir, "km_risk_table.csv"), row.names = FALSE)

## ---- summary per stratum: n, events, median + CI ----
med <- summary(fit)$table
med_df <- as.data.frame(med)
med_df$strata <- sub("^sex_label=", "", rownames(med_df))
km_summary <- data.frame(
  strata = med_df$strata,
  n = med_df$records,
  events = med_df$events,
  median = med_df$median,
  median_lower = med_df$`0.95LCL`,
  median_upper = med_df$`0.95UCL`
)

## ---- log-rank test ----
sd <- survdiff(Surv(time, status) ~ sex_label, data = lung)
chisq <- sd$chisq
df <- length(sd$n) - 1
pval <- pchisq(chisq, df, lower.tail = FALSE)

km_summary$logrank_chisq <- chisq
km_summary$logrank_df <- df
km_summary$logrank_p <- pval
write.csv(km_summary, file.path(out_dir, "km_summary.csv"), row.names = FALSE)

logrank <- data.frame(chisq = chisq, df = df, pvalue = pval)
write.csv(logrank, file.path(out_dir, "logrank.csv"), row.names = FALSE)

## ---- Cox PH forest table (complete cases) ----
cx_data <- lung[, c("time", "status", "age", "sex", "ph.ecog", "ph.karno", "wt.loss")]
cx_data <- cx_data[complete.cases(cx_data), ]
cx <- coxph(Surv(time, status) ~ age + sex + ph.ecog + ph.karno + wt.loss, data = cx_data)
sm <- summary(cx)
ci <- sm$conf.int
coefs <- sm$coefficients

term_labels <- c(
  age = "Age (per year)",
  sex = "Female vs male",
  ph.ecog = "ECOG performance score",
  ph.karno = "Karnofsky score (physician)",
  wt.loss = "Weight loss (lb)"
)

cox_forest <- data.frame(
  term = term_labels[rownames(ci)],
  hr = ci[, "exp(coef)"],
  lower = ci[, "lower .95"],
  upper = ci[, "upper .95"],
  pvalue = coefs[, "Pr(>|z|)"],
  n = sm$n
)
write.csv(cox_forest, file.path(out_dir, "cox_forest.csv"), row.names = FALSE)

cat("n complete cases for cox model:", sm$n, " events:", sm$nevent, "\n")
cat("wrote km_curve.csv rows:", nrow(km_curve), "\n")
cat("wrote km_risk_table.csv rows:", nrow(km_risk_table), "\n")
cat("wrote km_summary.csv rows:", nrow(km_summary), "\n")
cat("wrote logrank.csv rows:", nrow(logrank), "\n")
cat("wrote cox_forest.csv rows:", nrow(cox_forest), "\n")
