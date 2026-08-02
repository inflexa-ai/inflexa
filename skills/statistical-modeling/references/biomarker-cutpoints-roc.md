# Biomarker Cutpoints and Time-Dependent ROC Reference

Dichotomising a continuous biomarker, and evaluating its discrimination. These
are R packages via rpy2 — the reference implementations, and the reason not to
hand-roll either.

## Cutpoint Selection

### Survival outcome — maximally selected rank statistics

`survminer::surv_cutpoint` scans candidate cutpoints and returns the one
maximising the standardised log-rank statistic.

```r
library(survminer)

cp <- surv_cutpoint(df, time = "time", event = "event", variables = "marker")
cp$cutpoint          # data frame: cutpoint, statistic
groups <- surv_categorize(cp)   # adds a high/low factor for plotting
```

**`surv_cutpoint` returns the statistic but no p-value, and that omission is the
whole point of the method.** The maximum of a log-rank statistic over many
candidate cutpoints is not chi-squared distributed — taking the best of ~100
splits and reporting its nominal p-value manufactures significance from noise.
The multiplicity-corrected p-value comes from `maxstat`:

```r
library(maxstat)

m <- maxstat.test(Surv(time, event) ~ marker, data = df,
                  smethod = "LogRank", pmethod = "Lau94")
m$p.value      # corrected for having searched the cutpoints
m$estimate     # the cutpoint, same as surv_cutpoint
```

`pmethod` selects the correction: `"Lau94"` (Lausen & Schumacher) is the usual
choice; `"exactGauss"` is more accurate and slower; `"none"` returns the
uncorrected value and should never be reported.

Report the cutpoint, the corrected p-value, and the group sizes either side. A
cutpoint that splits 95/5 is a statistical artefact regardless of its p-value —
`surv_cutpoint` has a `minprop` argument (default 0.1) bounding how small the
smaller group may be.

### Binary outcome — criterion-based cutpoints

`OptimalCutpoints` implements the standard criteria, so the choice becomes which
criterion the clinical question implies rather than how to compute it.

```r
library(OptimalCutpoints)

oc <- optimal.cutpoints(X = "marker", status = "status", tag.healthy = 0,
                        methods = c("Youden", "MaxSpSe", "MinValueSp"),
                        data = df)
oc$Youden$Global$optimal.cutoff$cutoff
```

| Method | Optimises | Reach for it when |
|-|-|-|
| `Youden` | sensitivity + specificity − 1 | No reason to weight the two errors differently |
| `MaxSpSe` | the two as close to equal as possible | Balanced performance is the requirement |
| `MinValueSp` / `MinValueSe` | one subject to a floor on the other | A minimum sensitivity is clinically mandated (screening) |
| `MaxProdSpSe` | their product | Prevalence-insensitive summary |

Youden's J weights a false positive and a false negative equally. When they do
not carry equal clinical cost — most screening settings — say which criterion
you used and why, because the cutpoint moves substantially between them.

## Discrimination

### Binary outcome — analytic CI, not bootstrap

`pROC::ci.auc` gives a DeLong confidence interval in closed form. Bootstrapping
an AUC CI is slower, noisier and unnecessary.

```r
library(pROC)

r  <- roc(y, marker, quiet = TRUE)
ci <- ci.auc(r, method = "delong")     # c(lower, auc, upper)

# Comparing two markers on the SAME subjects is a paired problem:
roc.test(roc(y, marker_a, quiet = TRUE),
         roc(y, marker_b, quiet = TRUE),
         method = "delong")            # paired by default
```

Comparing two AUCs by checking whether their CIs overlap is not a test, and it
is conservative to the point of missing real differences. `roc.test` accounts
for the correlation induced by both markers being measured on the same subjects.

### Survival outcome — time-dependent AUC

A single AUC is undefined when outcomes are censored and event status depends on
follow-up time. `timeROC` estimates AUC at specified horizons, handling
censoring properly.

```r
library(survival)
library(timeROC)

r <- timeROC(T = df$time, delta = df$event, marker = df$marker,
             cause = 1, times = c(12, 24, 60), iid = TRUE)
r$AUC                    # one AUC per horizon
confint(r)$CI_AUC        # requires iid = TRUE
```

- `times` are on the same scale as `T`. Choose horizons that mean something
  clinically (1-year, 5-year), not evenly spaced values.
- `iid = TRUE` is what makes confidence intervals and comparisons available; it
  costs computation, so it is off by default and its absence is a common reason
  `confint()` fails.
- `cause = 1` names the event of interest. With competing risks, the other
  causes are handled as competing rather than censored — that is the difference
  between a cumulative-incidence and a Kaplan-Meier reading, and it changes the
  AUC.

**Applying a fixed-time AUC to censored survival data is the error this
replaces.** Treating "had the event by end of follow-up" as a binary label
discards the timing and misclassifies everyone censored early.

## Gotchas

- **Optimising and reporting on the same data.** A cutpoint chosen to maximise
  separation will separate. Report the corrected p-value, and validate on held-out
  data or by nested CV when the cutpoint feeds a model.
- **A dichotomised marker discards information.** It is justified by clinical
  need for a decision rule, not by statistics — the continuous marker in a Cox
  model is more powerful. Say which you are reporting and why.
- **Cutpoints do not transfer across assays or populations.** Report the assay,
  units, and the cohort it was derived in; a cutpoint without those is not
  reusable.
- **`iid = TRUE` before `confint()`** on a `timeROC` object, or it has nothing
  to compute the interval from.
