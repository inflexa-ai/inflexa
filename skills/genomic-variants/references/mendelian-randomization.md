# Mendelian Randomization Reference

Using genetic variants as instrumental variables to test whether an exposure
**causes** an outcome, rather than merely associating with it. Both packages are
R via rpy2.

## What Works Here, and What Does Not

`TwoSampleMR` is built around the OpenGWAS API, and that half is unreachable:

| Blocked (network) | Available (local data) |
|-|-|
| `available_outcomes()` | `format_data()` |
| `extract_instruments()` | `harmonise_data()` |
| `extract_outcome_data()` | `mr()` and every method it dispatches |
| `clump_data()` | `mr_heterogeneity()`, `mr_pleiotropy_test()` |
| | `directionality_test()`, `mr_leaveoneout()`, `mr_singlesnp()`, plots |

So **summary statistics must be supplied as files.** The workflow in most MR
tutorials — pull instruments by study ID from OpenGWAS — cannot run. Say so and
ask for the exposure and outcome GWAS summary statistics rather than attempting
the retrieval.

**LD clumping is not available either**, and this one changes the analysis rather
than just the plumbing. `clump_data()` needs the API; `ieugwasr::ld_clump()`
accepts a local `bfile`, but no PLINK-format LD reference panel is catalogued —
the staged 1000 Genomes entry is a phasing panel, a different product. So
**instruments must arrive already clumped.** Correlated instruments violate the
independence assumption behind IVW: the estimate is biased and its standard error
is understated, with nothing failing. Confirm independence with the person who
supplied the data and state the clumping parameters they used.

## Choosing a Package

- **`TwoSampleMR`** when starting from two sets of raw summary statistics. Its
  value is `harmonise_data()`, which aligns effect alleles between studies and
  handles palindromic SNPs — the step most MR errors come from.
- **`MendelianRandomization`** when the effect estimates are already harmonised
  and you just want the estimators. It takes vectors directly, with no data-frame
  ceremony.

## TwoSampleMR — Local Workflow

```r
library(TwoSampleMR)

exposure <- format_data(exposure_df, type = "exposure")
outcome  <- format_data(outcome_df,  type = "outcome")
dat      <- harmonise_data(exposure, outcome)

res <- mr(dat)   # Egger, weighted median, IVW, simple mode, weighted mode
```

`format_data()` expects `SNP`, `beta`, `se`, `effect_allele`, `other_allele`,
`eaf`, `pval`, and `samplesize` where available. Column names differing from
these are mapped by the `*_col` arguments.

`harmonise_data()` takes an `action` argument: `2` (default) infers the forward
strand for palindromic SNPs from allele frequency; `3` drops all palindromes.
Use `3` when allele frequencies are unreliable or absent — inferring strand from
a bad EAF silently flips effect directions.

### Required diagnostics

Run all of these. An IVW estimate reported alone is not an MR analysis.

```r
mr_heterogeneity(dat)      # Cochran's Q — heterogeneity implies invalid instruments
mr_pleiotropy_test(dat)    # Egger intercept — nonzero means directional pleiotropy
directionality_test(dat)   # Steiger — is the causal direction the assumed one?
mr_leaveoneout(dat)        # is the result carried by one SNP?
mr_singlesnp(dat)          # per-instrument estimates
```

**Instrument strength.** Weak instruments bias two-sample MR toward the null and
one-sample MR toward the confounded estimate. Compute the F-statistic per
instrument and report the mean; below ~10 is conventionally weak:

```r
f_stat <- (dat$beta.exposure / dat$se.exposure)^2
mean(f_stat)
```

### Plots

`mr_scatter_plot(res, dat)`, `mr_forest_plot(mr_singlesnp(dat))` and
`mr_funnel_plot(mr_singlesnp(dat))` return ggplot objects — save them with the
figure conventions the rest of the analysis uses.

## MendelianRandomization — Estimator-Only

```r
library(MendelianRandomization)

inp <- mr_input(bx = bx, bxse = bxse, by = by, byse = byse, snps = snp_ids)

mr_ivw(inp)       # inverse-variance weighted
mr_egger(inp)     # allows directional pleiotropy; intercept tests for it
mr_median(inp)    # weighted median; consistent if <50% of weight is invalid
mr_allmethods(inp)   # all of the above in one table
```

## Interpreting the Estimator Set

The methods differ in which assumption they relax, so **agreement between them is
the evidence, not any single estimate**:

| Method | Valid when | Breaks when |
|-|-|-|
| IVW | all instruments valid | any directional pleiotropy |
| Weighted median | >50% of weight from valid instruments | most instruments invalid |
| MR-Egger | pleiotropy independent of instrument strength (InSIDE) | InSIDE violated; low power, wide CIs |
| Modes | the largest cluster of instruments is valid | no dominant cluster |

Report all of them. When IVW and weighted median agree and the Egger intercept is
null, the result is robust. When they diverge, the divergence *is* the finding —
report it rather than selecting the estimate that fits the hypothesis.

## Gotchas

- **Sample overlap between exposure and outcome GWAS reintroduces confounding**,
  which two-sample MR assumes away. Establish whether the two studies share
  participants; if they do, or if it is unknown, say so as a limitation.
- **MR estimates a lifelong effect of genetically-proxied exposure**, not the
  effect of an intervention at one point in time. A causal MR result does not
  imply a drug targeting that exposure will work at the effect size estimated.
- **Population stratification and ancestry mismatch.** Instruments discovered in
  one ancestry may not be valid in another; exposure and outcome GWAS should come
  from the same ancestry, and the ancestry should be reported.
- **A null MR result with weak instruments says nothing.** Report the F-statistic
  alongside every null, or the absence of an effect cannot be distinguished from
  the absence of power.
