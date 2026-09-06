#!/usr/bin/env python3
# tpl-lifelines-cox — Cox model of the time to event on a per-sample signature score, with lifelines.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: the Python mirror of tpl-survival-cox. The expression filter of edgeR
# (filterByExpr, through decoupler filter_by_expr), the library size scaling
# factors of edgeR (TMM, RLE, upper quartile, or none) computed in numpy, and
# the log-CPM of edgeR with a prior count, then the per-sample signature score
# as the mean log-CPM of the signature genes, standardized to mean 0 and
# standard deviation 1. A Cox proportional hazards model of the time to event
# on the standardized score as a continuous term, with the clinical covariates
# in the same model (Cox 1972), fit with lifelines CoxPHFitter (Efron ties).
# The proportional hazards assumption is tested on the scaled Schoenfeld
# residuals (lifelines proportional_hazard_test). A Kaplan-Meier curve by the
# median split of the score is drawn for the picture only, with the log-rank
# p-value of the split as a secondary statistic. The inference stays in the
# continuous model.

import json
import os
import platform
import sys
from importlib import metadata as importlib_metadata

import matplotlib

matplotlib.use("Agg")
import anndata  # noqa: E402
import decoupler as dc  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from lifelines import CoxPHFitter, KaplanMeierFitter  # noqa: E402
from lifelines.statistics import logrank_test, proportional_hazard_test  # noqa: E402
from scipy.stats import rankdata  # noqa: E402

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH          = {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH        = {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN     = {{sample_id_column}}  # [adaptable: sample_id_column]
TIME_COLUMN          = {{time_column}}  # [adaptable: time_column]
EVENT_COLUMN         = {{event_column}}  # [adaptable: event_column]
SIGNATURE_GENES      = {{signature_genes}}  # [adaptable: signature_genes]
{{#if covariates}}
COVARIATES           = {{covariates}}  # [adaptable: covariates]
{{/if}}
{{#unless covariates}}
COVARIATES           = []  # [adaptable: covariates] empty: the model holds the score only
{{/unless}}
MIN_COUNT            = {{min_count}}  # [adaptable: min_count]
MIN_TOTAL_COUNT      = {{min_total_count}}  # [adaptable: min_total_count]
NORMALIZATION_METHOD = {{normalization_method}}  # [adaptable: normalization_method]
MIN_SIGNATURE_GENES  = {{min_signature_genes}}  # [adaptable: min_signature_genes]
TIES                 = {{ties}}
ALPHA                = {{alpha}}
OUTPUT_PREFIX        = {{output_prefix}}  # [adaptable: output_prefix]
PRIOR_COUNT          = 2.0  # the prior count of the log-CPM (Law et al. 2018)
PH_TRANSFORM         = "km"  # the time transform of the Schoenfeld test (Grambsch and Therneau 1994)
CPM_SCALE            = 1e6
LOGRATIO_TRIM        = 0.3  # the M-value trim of TMM (Robinson and Oshlack 2010)
SUM_TRIM             = 0.05  # the A-value trim of TMM
A_CUTOFF             = -1e10  # the A-value floor of TMM, as in edgeR

os.makedirs("output", exist_ok=True)
os.makedirs("figures", exist_ok=True)


def message(*parts):
    print("".join(str(part) for part in parts), file=sys.stderr, flush=True)


def fail(*parts):
    sys.exit("".join(str(part) for part in parts))


def out(name):
    return os.path.join("output", f"{OUTPUT_PREFIX}_{name}")


def fig(name):
    return os.path.join("figures", f"{OUTPUT_PREFIX}_{name}")


def save_figure(figure, name, width=7, height=6):
    figure.set_size_inches(width, height)
    figure.savefig(fig(f"{name}.png"), dpi=300, bbox_inches="tight")
    figure.savefig(fig(f"{name}.pdf"), bbox_inches="tight")
    plt.close(figure)


SIGNATURE_GENES = list(dict.fromkeys(str(gene) for gene in SIGNATURE_GENES))
if len(SIGNATURE_GENES) == 0:
    fail("The signature gene list is empty")
if MIN_SIGNATURE_GENES < 1:
    fail("min_signature_genes must be at least 1")
if TIES != "efron":
    fail("lifelines CoxPHFitter fits with the Efron approximation for tied event times only, not ", TIES)
if NORMALIZATION_METHOD not in ("TMM", "RLE", "upperquartile", "none"):
    fail("normalization_method must be TMM, RLE, upperquartile, or none, not ", NORMALIZATION_METHOD)

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
if not os.path.exists(COUNTS_PATH):
    fail("The count matrix does not exist: ", COUNTS_PATH)
counts_df = pd.read_csv(COUNTS_PATH)
gene_ids = counts_df.iloc[:, 0].astype(str)
counts = counts_df.iloc[:, 1:].copy()
counts.index = gene_ids
counts.columns = [str(column) for column in counts.columns]
counts = counts.apply(pd.to_numeric, errors="coerce")
if counts.isna().any().any() or (counts < 0).any().any() or ((counts - counts.round()).abs() > 1e-6).any().any():
    fail("The count matrix must hold non-negative integers. The log-CPM starts from raw counts, not TPM or FPKM.")
counts = counts.round()
if gene_ids.duplicated().any():
    fail("The count matrix holds duplicate gene identifiers")

message("Reading the sample table from ", METADATA_PATH)
if not os.path.exists(METADATA_PATH):
    fail("The sample table does not exist: ", METADATA_PATH)
sample_table = pd.read_csv(METADATA_PATH)
for column in (SAMPLE_ID_COLUMN, TIME_COLUMN, EVENT_COLUMN):
    if column not in sample_table.columns:
        fail("The sample table has no column ", column)
sample_table.index = sample_table[SAMPLE_ID_COLUMN].astype(str)
missing = [sample for sample in counts.columns if sample not in sample_table.index]
if missing:
    fail("Samples in the counts but not in the sample table: ", ", ".join(missing))
sample_table = sample_table.loc[list(counts.columns)]

# The outcome: a positive time and a 0/1 event. True/False is accepted as 1/0.
time_values = pd.to_numeric(sample_table[TIME_COLUMN], errors="coerce")
if time_values.isna().any():
    fail("The time column ", TIME_COLUMN, " holds a missing or a non-numeric value")
if (time_values <= 0).any():
    fail("The time column ", TIME_COLUMN, " holds a value of zero or less. A follow-up time must be positive.")
event_raw = sample_table[EVENT_COLUMN]
if pd.api.types.is_bool_dtype(event_raw):
    event_raw = event_raw.astype(int)
event_values = pd.to_numeric(event_raw, errors="coerce")
if event_values.isna().any() or not event_values.isin([0, 1]).all():
    fail("The event column ", EVENT_COLUMN, " must hold 0 (censored) or 1 (event) for every sample")
event_values = event_values.astype(int)
n_events = int(event_values.sum())
if n_events == 0:
    fail("The event column holds no event. A Cox model needs at least one event.")
if n_events < 10:
    message("Caution: only ", n_events, " events. The hazard ratio of a small event count is unstable.")

# The model frame: the time, the event, the score (added below), and the
# covariates. A character covariate becomes a categorical whose first level in
# sorted order is the reference, as a factor in R. A numeric covariate stays numeric.
model_frame = pd.DataFrame({"time": time_values.astype(float).to_numpy(), "event": event_values.to_numpy()}, index=sample_table.index)
COVARIATES = [str(column) for column in COVARIATES]
duplicated_covariates = [column for column in set(COVARIATES) if COVARIATES.count(column) > 1]
if duplicated_covariates:
    fail("The covariates list names a column two times: ", ", ".join(sorted(duplicated_covariates)))
for column in COVARIATES:
    if column in (SAMPLE_ID_COLUMN, TIME_COLUMN, EVENT_COLUMN):
        fail("The covariates list names ", column, ", which is the sample identifier, the time, or the event")
    if column in ("signature_score", "time", "event"):
        fail("The covariates list names ", column, ", which is a reserved name of the model")
    if column not in sample_table.columns:
        fail("The covariates list names ", column, " but the sample table has no such column")
    values = sample_table[column]
    if values.isna().any():
        fail("The covariate ", column, " has a missing value. Every sample needs a value for each covariate.")
    if pd.api.types.is_numeric_dtype(values) and not pd.api.types.is_bool_dtype(values):
        model_frame[column] = values.astype(float).to_numpy()
    else:
        levels = sorted(set(values.astype(str)))
        if len(levels) < 2:
            fail("The covariate ", column, " holds one level only, thus it adds nothing to the model.")
        model_frame[column] = pd.Categorical(values.astype(str).to_numpy(), categories=levels)
message("Samples: ", counts.shape[1], "; genes: ", counts.shape[0], "; events: ", n_events, " of ", counts.shape[1])
if COVARIATES:
    message("Covariates: ", ", ".join(COVARIATES))

# ── Filter, scale, log-CPM ────────────────────────────────────────────────────
# The expression filter serves the scaling factors only: the library sizes and
# the scaling factors come from the expressed genes. The log-CPM then covers
# every gene of the count matrix, thus a fixed signature keeps each member that
# the count matrix holds. filter_by_expr of decoupler is the port of
# filterByExpr of edgeR, and the scaling factors below are the port of
# calcNormFactors of edgeR.
adata = anndata.AnnData(X=counts.T.to_numpy(dtype=float), obs=pd.DataFrame(index=counts.columns), var=pd.DataFrame(index=counts.index))
kept_genes = [str(gene) for gene in dc.pp.filter_by_expr(adata, group=None, min_count=MIN_COUNT, min_total_count=MIN_TOTAL_COUNT, inplace=False)]
keep = counts.index.isin(kept_genes)
message("filter_by_expr: ", int(keep.sum()), " of ", counts.shape[0], " genes expressed; the scaling factors come from these")
if keep.sum() == 0:
    fail("No gene passes the expression filter")
filtered = counts.loc[keep].to_numpy(dtype=float)
library_sizes = filtered.sum(axis=0)
if (library_sizes <= 0).any():
    fail("A sample has no counts after the filter: ", ", ".join(counts.columns[library_sizes <= 0]))


def tmm_factor(observed, reference, size_observed, size_reference):
    """The TMM factor of one sample against the reference, as .calcFactorTMM of edgeR."""
    with np.errstate(divide="ignore", invalid="ignore"):
        log_ratio = np.log2((observed / size_observed) / (reference / size_reference))
        abs_expression = (np.log2(observed / size_observed) + np.log2(reference / size_reference)) / 2
        variance = (size_observed - observed) / size_observed / observed + (size_reference - reference) / size_reference / reference
    finite = np.isfinite(log_ratio) & np.isfinite(abs_expression) & (abs_expression > A_CUTOFF)
    log_ratio, abs_expression, variance = log_ratio[finite], abs_expression[finite], variance[finite]
    if log_ratio.size == 0 or np.max(np.abs(log_ratio)) < 1e-6:
        return 1.0
    n = log_ratio.size
    low_ratio = np.floor(n * LOGRATIO_TRIM) + 1
    high_ratio = n + 1 - low_ratio
    low_sum = np.floor(n * SUM_TRIM) + 1
    high_sum = n + 1 - low_sum
    rank_ratio = rankdata(log_ratio)
    rank_expression = rankdata(abs_expression)
    trimmed = (rank_ratio >= low_ratio) & (rank_ratio <= high_ratio) & (rank_expression >= low_sum) & (rank_expression <= high_sum)
    weighted = np.sum(log_ratio[trimmed] / variance[trimmed]) / np.sum(1 / variance[trimmed])
    if not np.isfinite(weighted):
        weighted = 0.0
    return float(2**weighted)


def scaling_factors(matrix, sizes, method):
    """The library size scaling factors of calcNormFactors of edgeR, normalized to a geometric mean of 1."""
    if method == "none":
        return np.ones(matrix.shape[1])
    if method == "TMM":
        upper_quartiles = np.quantile(matrix / sizes, 0.75, axis=0)
        if np.median(upper_quartiles) < 1e-20:
            reference = int(np.argmax(matrix.sum(axis=0)))
        else:
            reference = int(np.argmin(np.abs(upper_quartiles - upper_quartiles.mean())))
        factors = np.array([tmm_factor(matrix[:, index], matrix[:, reference], sizes[index], sizes[reference]) for index in range(matrix.shape[1])])
    elif method == "RLE":
        with np.errstate(divide="ignore"):
            geometric_means = np.exp(np.mean(np.log(matrix), axis=1))
        positive = geometric_means > 0
        if positive.sum() == 0:
            fail("No gene has a positive count in every sample, thus the RLE factors cannot be estimated. Use TMM or none.")
        factors = np.array([np.median(matrix[positive, index] / geometric_means[positive]) for index in range(matrix.shape[1])]) / sizes
    else:
        factors = np.quantile(matrix / sizes, 0.75, axis=0)
        if (factors <= 0).any():
            fail("A sample has an upper quartile of zero, thus the upperquartile factors cannot be estimated. Use TMM or none.")
    return factors / np.exp(np.mean(np.log(factors)))


norm_factors = scaling_factors(filtered, library_sizes, NORMALIZATION_METHOD)
message("Scaling factors (", NORMALIZATION_METHOD, "): ", ", ".join(f"{sample}={factor:.3f}" for sample, factor in zip(counts.columns, norm_factors)))
# The log-CPM of edgeR: the prior count is scaled by the effective library size,
# and the library size grows by two times the scaled prior.
effective_sizes = library_sizes * norm_factors
prior_scaled = PRIOR_COUNT * effective_sizes / effective_sizes.mean()
log_cpm = pd.DataFrame(np.log2((counts.to_numpy(dtype=float) + prior_scaled) / (effective_sizes + 2 * prior_scaled) * CPM_SCALE), index=counts.index, columns=counts.columns)

# ── Signature score ───────────────────────────────────────────────────────────
found = [gene for gene in SIGNATURE_GENES if gene in log_cpm.index]
absent = [gene for gene in SIGNATURE_GENES if gene not in log_cpm.index]
kept_set = set(kept_genes)
n_found_below_filter = sum(1 for gene in found if gene not in kept_set)
message("Signature genes: ", len(found), " of ", len(SIGNATURE_GENES), " in the count matrix; ", n_found_below_filter, " below the expression filter")
if absent:
    message("Signature genes not in the count matrix: ", ", ".join(absent))
if len(found) < MIN_SIGNATURE_GENES:
    fail("Only ", len(found), " signature genes are in the count matrix, fewer than min_signature_genes (", MIN_SIGNATURE_GENES, ")")
score_raw = log_cpm.loc[found].mean(axis=0)
score_sd = float(score_raw.std(ddof=1))
if not np.isfinite(score_sd) or score_sd == 0:
    fail("The signature score is constant across the samples, thus the model has no term to fit")
model_frame["signature_score"] = ((score_raw - score_raw.mean()) / score_sd).to_numpy()
score_median = float(np.median(model_frame["signature_score"]))
risk_group = np.where(model_frame["signature_score"] > score_median, "high", "low")
model_frame["risk_group"] = pd.Categorical(risk_group, categories=["low", "high"])

# ── Cox model ─────────────────────────────────────────────────────────────────
model_terms = ["signature_score"] + COVARIATES
cox_formula = " + ".join(model_terms)
model_text = "Surv(time, event) ~ " + cox_formula
message("Cox model: ", model_text, "; ties: ", TIES)
cox_frame = model_frame[["time", "event"] + model_terms]
fit = CoxPHFitter()
try:
    fit.fit(cox_frame, duration_col="time", event_col="event", formula=cox_formula)
except Exception as error:  # a singular design or a non-convergent fit
    fail("The Cox model did not fit: ", error, ". A covariate is confounded with another term, or the events are too few. Remove it.")
if not np.isfinite(fit.params_.to_numpy()).all():
    fail("A coefficient is not estimable: ", ", ".join(fit.params_.index[~np.isfinite(fit.params_.to_numpy())]), ". A covariate is confounded with another term. Remove it.")
fit_summary = fit.summary
cox_table = pd.DataFrame(
    {
        "term": fit_summary.index.astype(str),
        "hazard_ratio": fit_summary["exp(coef)"].to_numpy(),
        "ci_low": fit_summary["exp(coef) lower 95%"].to_numpy(),
        "ci_high": fit_summary["exp(coef) upper 95%"].to_numpy(),
        "pvalue": fit_summary["p"].to_numpy(),
    }
)
cox_table.to_csv(out("cox.csv"), index=False, na_rep="NA")
signature_row = cox_table[cox_table["term"] == "signature_score"].iloc[0]
concordance = float(fit.concordance_index_)
message(f"Signature: hazard ratio per 1 SD = {signature_row['hazard_ratio']:.3f} [{signature_row['ci_low']:.3f}, {signature_row['ci_high']:.3f}], p = {signature_row['pvalue']:.3g}")
message(f"Concordance: {concordance:.3f}")

# ── Proportional hazards test ─────────────────────────────────────────────────
# lifelines tests each term on its scaled Schoenfeld residuals. It gives no
# global test, thus the ph_test table holds the per-term rows only.
ph_result = proportional_hazard_test(fit, cox_frame, time_transform=PH_TRANSFORM)
ph_summary = ph_result.summary
ph_table = pd.DataFrame(
    {
        "term": ph_summary.index.astype(str),
        "chisq": ph_summary["test_statistic"].to_numpy(),
        "df": np.ones(len(ph_summary), dtype=int),
        "p": ph_summary["p"].to_numpy(),
    }
)
ph_table = ph_table.set_index("term").loc[list(cox_table["term"])].reset_index()
ph_table.to_csv(out("ph_test.csv"), index=False, na_rep="NA")
ph_signature_pvalue = float(ph_table.loc[ph_table["term"] == "signature_score", "p"].iloc[0])
message(f"Proportional hazards test: signature p = {ph_signature_pvalue:.3g}")
if ph_signature_pvalue < ALPHA:
    message("Caution: the proportional hazards assumption fails for the signature at p < ", ALPHA, ". Report a stratified model or a time-dependent effect, not the single hazard ratio.")

# ── Median split, for the figure only ─────────────────────────────────────────
low = model_frame[model_frame["risk_group"] == "low"]
high = model_frame[model_frame["risk_group"] == "high"]
split_test = logrank_test(low["time"], high["time"], event_observed_A=low["event"], event_observed_B=high["event"])
logrank_pvalue = float(split_test.p_value)
message(f"Log-rank of the median split (secondary): p = {logrank_pvalue:.3g}")

scores_table = pd.DataFrame(
    {
        "sample": model_frame.index.astype(str),
        "signature_score_raw": score_raw.to_numpy(),
        "signature_score": model_frame["signature_score"].to_numpy(),
        "risk_group": model_frame["risk_group"].astype(str).to_numpy(),
        "time": model_frame["time"].to_numpy(),
        "event": model_frame["event"].to_numpy(),
    }
)
scores_table.to_csv(out("scores.csv"), index=False, na_rep="NA")

# ── Figures ───────────────────────────────────────────────────────────────────
# The Kaplan-Meier curves on the upper axis and the at-risk counts of each
# group on the lower axis, at the ticks of the time axis.
km_figure, (axis, risk_axis) = plt.subplots(2, 1, gridspec_kw={"height_ratios": [5, 1]}, sharex=True)
groups = (("low", "low (below the median)", "#21908C"), ("high", "high (above the median)", "#440154"))
for group, label, color in groups:
    subset = model_frame[model_frame["risk_group"] == group]
    km = KaplanMeierFitter(label=label)
    km.fit(subset["time"], event_observed=subset["event"])
    km.plot_survival_function(ax=axis, ci_show=True, color=color, show_censors=True, censor_styles={"ms": 4, "marker": "|"})
axis.set_ylim(0, 1.02)
axis.set_xlim(0, None)
axis.set_ylabel("Survival probability")
axis.set_title(
    f"Kaplan-Meier by the median split of the score (log-rank p = {logrank_pvalue:.2g})\n"
    f"Cox: hazard ratio per 1 SD = {signature_row['hazard_ratio']:.2f} [{signature_row['ci_low']:.2f}, {signature_row['ci_high']:.2f}], p = {signature_row['pvalue']:.2g}",
    fontsize=10,
)
axis.legend(title="Signature score", loc="lower left", fontsize=8)
risk_ticks = [tick for tick in axis.get_xticks() if tick >= 0]
risk_axis.set_xticks(risk_ticks)
risk_axis.set_yticks([0, 1])
risk_axis.set_yticklabels(["high", "low"], fontsize=8)
risk_axis.set_ylim(-0.5, 1.5)
for row, (group, _label, color) in zip((1, 0), groups):
    group_times = model_frame.loc[model_frame["risk_group"] == group, "time"].to_numpy()
    for tick in risk_ticks:
        risk_axis.text(tick, row, str(int((group_times >= tick).sum())), ha="center", va="center", fontsize=8, color=color)
risk_axis.set_xlabel("Time")
risk_axis.set_title("Number at risk", fontsize=8, loc="left")
for side in ("top", "right", "left"):
    risk_axis.spines[side].set_visible(False)
risk_axis.tick_params(axis="y", length=0, pad=16)  # the row labels sit left of the count at time 0
save_figure(km_figure, "km")

# The scaled Schoenfeld residuals of the score against the transformed time of
# each event, with a running mean as the smooth. A trend shows a time-dependent effect.
residuals = fit.compute_residuals(cox_frame, "scaled_schoenfeld")  # one row per event, indexed by the sample
event_times = cox_frame.loc[residuals.index, "time"].to_numpy()
order = np.argsort(event_times, kind="stable")
event_times = event_times[order]
score_residuals = residuals["signature_score"].to_numpy()[order]
km_all = KaplanMeierFitter().fit(cox_frame["time"], event_observed=cox_frame["event"])
transformed = 1 - km_all.survival_function_at_times(event_times).to_numpy()
window = max(5, len(score_residuals) // 10)
smooth = pd.Series(score_residuals).rolling(window, center=True, min_periods=1).mean().to_numpy()
schoenfeld_figure, axis = plt.subplots()
axis.scatter(transformed, score_residuals, s=8, color="#440154", alpha=0.7, linewidths=0)
axis.plot(transformed, smooth, color="#21908C", linewidth=1.5)
axis.axhline(float(fit.params_["signature_score"]), linestyle="--", color="black", linewidth=0.8)
axis.set_xlabel(f"Transformed time ({PH_TRANSFORM})")
axis.set_ylabel("Scaled Schoenfeld residual of the score")
axis.set_title(f"Proportional hazards test of the score: chi-square p = {ph_signature_pvalue:.2g}", fontsize=10)
save_figure(schoenfeld_figure, "schoenfeld", width=6, height=5)

# ── Summary ───────────────────────────────────────────────────────────────────
PACKAGES = ["lifelines", "decoupler", "anndata", "pandas", "numpy", "scipy", "matplotlib", "autograd", "formulaic"]


def package_version(name):
    try:
        return importlib_metadata.version(name)
    except importlib_metadata.PackageNotFoundError:
        return None


split_sizes = model_frame["risk_group"].value_counts()
summary_record = {
    "template": "tpl-lifelines-cox@1.0.0",
    "method": "Cox proportional hazards on a standardized signature score (lifelines)",
    "model": model_text,
    "ties": TIES,
    "n_samples": int(counts.shape[1]),
    "n_events": n_events,
    "n_censored": int(counts.shape[1]) - n_events,
    "n_signature_genes_given": len(SIGNATURE_GENES),
    "n_signature_genes_found": len(found),
    "n_signature_genes_below_filter": int(n_found_below_filter),
    "signature_genes_absent": absent,
    "covariates": COVARIATES,
    "signature_hazard_ratio": float(signature_row["hazard_ratio"]),
    "signature_ci_low": float(signature_row["ci_low"]),
    "signature_ci_high": float(signature_row["ci_high"]),
    "signature_pvalue": float(signature_row["pvalue"]),
    "concordance": concordance,
    "ph_test_pvalue": ph_signature_pvalue,
    "ph_global_pvalue": None,
    "ph_transform": PH_TRANSFORM,
    "ph_holds_at_alpha": bool(ph_signature_pvalue >= ALPHA),
    "logrank_median_split_pvalue": logrank_pvalue,
    "median_split_sizes": {"low": int(split_sizes.get("low", 0)), "high": int(split_sizes.get("high", 0))},
    "alpha": ALPHA,
    "min_count": MIN_COUNT,
    "min_total_count": MIN_TOTAL_COUNT,
    "normalization_method": NORMALIZATION_METHOD,
    "prior_count": PRIOR_COUNT,
    "n_genes_input": int(len(gene_ids)),
    "n_genes_expressed": int(keep.sum()),
    "versions": {"python": platform.python_version(), **{name: package_version(name) for name in ["lifelines", "decoupler", "pandas", "numpy", "scipy", "matplotlib"]}},
}
with open(out("summary.json"), "w", encoding="utf-8") as handle:
    json.dump(summary_record, handle, indent=2)
with open(os.path.join("output", "session_info.txt"), "w", encoding="utf-8") as handle:
    handle.write(f"Python {platform.python_version()} on {platform.platform()}\n")
    for name in PACKAGES:
        handle.write(f"{name} {package_version(name) or 'not installed'}\n")
message("Done: ", out("cox.csv"))
