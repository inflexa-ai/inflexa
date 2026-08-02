# Population PK (Nonlinear Mixed Effects) Reference

True population PK: fit a structural compartmental model, inter-individual
variability (IIV) on its parameters, and a residual error model **simultaneously**
from concentration-time data. `nlmixr2` is the tool; models are written in R, so
this is an R-dominant pipeline — write a native R script rather than driving it
through rpy2.

Use this when the question is about the PK model itself: what the clearance and
volume are, how much they vary between patients, what explains that variation,
or what a different regimen would produce. For covariate testing on parameters
you have *already derived* per subject by NCA, see `population-pk.md` — that is a
different and simpler method with different assumptions.

**NLME is the only option when sampling is sparse.** Two-stage needs enough
points per subject to estimate that subject's parameters; NLME borrows strength
across subjects and works with a few samples each.

## Model Syntax

A model is a function with an `ini({})` block (starting estimates) and a
`model({})` block (structure). Names beginning `eta.` declared with `~` are IIV
terms; `<-` declares a fixed effect.

```r
library(nlmixr2)

one.cmt <- function() {
  ini({
    tka <- 0.45        # log absorption rate
    tcl <- 1           # log clearance
    tv  <- 3.45        # log central volume
    eta.ka ~ 0.6       # IIV, variance on the log scale
    eta.cl ~ 0.3
    eta.v  ~ 0.1
    add.sd <- 0.7      # additive residual error
  })
  model({
    ka <- exp(tka + eta.ka)
    cl <- exp(tcl + eta.cl)
    v  <- exp(tv  + eta.v)
    linCmt() ~ add(add.sd)
  })
}

fit <- nlmixr2(one.cmt, theo_sd, est = "saem",
               control = saemControl(nBurn = 200, nEm = 300, print = 0))
```

- Parameters are estimated on the log scale and exponentiated in `model({})`, so
  they stay positive and IIV is lognormal — the standard PK parameterisation.
- `linCmt()` picks the closed-form linear model implied by the parameter names
  (`ka`/`cl`/`v` = one-compartment oral). Write explicit ODEs with `d/dt()` when
  the structure is nonlinear (Michaelis-Menten elimination, target-mediated
  disposition).
- Residual error: `add()` additive, `prop()` proportional, `add() + prop()`
  combined. Proportional or combined is usual for concentrations.
- Data must be in NONMEM-style long format: `ID`, `TIME`, `DV`, `AMT`, `EVID`,
  plus covariate columns. Covariates are referenced by column name directly.

## The OBJF Trap

**After SAEM, `fit$objDf$OBJF` is `NA`.** SAEM does not compute a likelihood as
it goes. `addCwres()` computes it — and adds the conditional residuals at the
same time:

```r
fit <- addCwres(fit)     # adds WRES, CPRED, CRES, CWRES; fills in OBJF
```

This matters because covariate selection is a likelihood-ratio test between
nested fits. Comparing two models before calling `addCwres()` compares `NA` to
`NA` and silently concludes nothing. Do this before any model comparison, and
report the OBJF you actually compared.

## Estimation Methods

| `est=` | When |
|-|-|
| `"saem"` | Default. Stochastic approximation EM — robust starting-value behaviour, handles high IIV. Needs `addCwres()` for OBJF. |
| `"focei"` | First-order conditional estimation with interaction. Computes OBJF directly and is the reference method for likelihood comparison, but is more sensitive to starting values. |
| `"nlme"` | Available for simple models; rarely the right choice over the two above. |

Compilation happens on first fit and takes tens of seconds; subsequent fits of
the same structure reuse it.

## Covariate Modelling

Covariates enter as terms on the structural parameter, usually allometric for
size and power/linear for function:

```r
cov.mod <- function() {
  ini({
    tka <- 0.45; tcl <- 1; tv <- 3.45
    wt.cl <- 0.75                       # allometric exponent on weight
    eta.ka ~ 0.6; eta.cl ~ 0.3; eta.v ~ 0.1
    add.sd <- 0.7
  })
  model({
    ka <- exp(tka + eta.ka)
    cl <- exp(tcl + eta.cl + wt.cl * log(WT / 70))    # WT is a data column
    v  <- exp(tv + eta.v)
    linCmt() ~ add(add.sd)
  })
}
```

Selection is forward addition then backward elimination, judged on the objective
function:

```r
base <- addCwres(nlmixr2(one.cmt, dat, est = "saem", control = saemControl(print = 0)))
cov1 <- addCwres(nlmixr2(cov.mod,  dat, est = "saem", control = saemControl(print = 0)))

dOBJF <- base$objDf$OBJF[1] - cov1$objDf$OBJF[1]   # chi-squared, df = params added
# Forward: keep at p < 0.05 (dOBJF > 3.84 for 1 df)
# Backward: retain only at p < 0.001 (dOBJF > 10.83 for 1 df)
```

The asymmetric thresholds are deliberate — the backward step is stricter because
forward selection on the same data inflates significance.

Two checks that decide whether a covariate is real:

- **Does it reduce IIV?** `parFixedDf` reports `BSV(CV%)` per parameter. A
  covariate that lowers OBJF without shrinking the between-subject variability on
  its parameter has explained nothing mechanistic. Report both.
- **Is the shrinkage low enough to trust?** `Shrink(SD)%` above ~30% means the
  individual estimates have collapsed toward the population mean, and covariate
  relationships plotted against those etas are artefacts. High shrinkage is a
  reason to stop, not a number to omit.

## Diagnostics

`as.data.frame(fit)` returns one row per observation:

| Column | Meaning |
|-|-|
| `DV` | observed |
| `PRED` / `IPRED` | population / individual prediction |
| `RES`, `IRES`, `IWRES` | residuals; individual; individual weighted |
| `CWRES`, `CPRED` | conditional weighted residuals (after `addCwres()`) |
| `eta.*` | per-subject random effects |
| `tad` | time after dose |

Standard goodness-of-fit set, all plotted from that frame:

1. DV vs PRED and DV vs IPRED, with the line of identity.
2. CWRES vs TIME and CWRES vs PRED — structure here means the structural or
   error model is wrong, not that a covariate is missing.
3. IWRES vs IPRED — a funnel means the residual error model is misspecified
   (usually additive where it should be proportional).
4. eta distributions and eta-vs-covariate plots, read alongside the shrinkage.

`parFixedDf` carries `Estimate`, `SE`, `%RSE`, `Back-transformed`, `CI Lower`,
`CI Upper`, `BSV(CV%)` and `Shrink(SD)%`. Report back-transformed values with
their CI — the estimates themselves are on the log scale.

## Simulation from a Fitted Model

`mrgsolve` simulates regimens the trial did not run. Models compile from inline
code; parameters come from the fit.

```r
library(mrgsolve)

code <- "
$PARAM CL = 2.8, V = 31.5, KA = 1.6
$CMT GUT CENT
$ODE
dxdt_GUT  = -KA*GUT;
dxdt_CENT =  KA*GUT - (CL/V)*CENT;
$TABLE
capture CP = CENT/V;
"

mod <- mcode('popk', code)
out <- mrgsim(mod, events = ev(amt = 100, ii = 24, addl = 6), end = 168, delta = 1)
```

- `ev()` builds the regimen: `amt` dose, `ii` interval, `addl` additional doses.
- For a population simulation, pass a data frame of per-subject parameters drawn
  from the fitted IIV via `idata_set()`, rather than simulating the typical
  subject and presenting it as a population range.
- `PKPDsim` covers the same ground with a library of named structural models
  (`new_ode_model("pk_1cmt_oral")`) when you do not need custom ODEs.
- `pksensi` does global sensitivity analysis (eFAST) over a parameter space —
  which parameters actually drive exposure, before deciding what to estimate.

## Gotchas

- **A linear mixed model on concentrations is not population PK.** It has no
  absorption, distribution or elimination structure, so it cannot produce CL or
  V, cannot extrapolate to another regimen, and its "random effect" is not IIV on
  a PK parameter. Use it only on parameters already derived per subject, and say
  which you did.
- **Report the residual error model.** Additive on concentrations that span
  orders of magnitude fits the high values and ignores the low ones.
- **Parameters are not identifiable without informative sampling.** Absorption
  needs early points; terminal elimination needs late ones. A two-compartment
  model fitted to a sampling schedule with no distribution-phase points will
  converge and be meaningless — check the design before adding compartments.
- **`nlmixr2` compiles model code on first fit.** A model that fails to compile
  is a syntax error in the `model({})` block, not a missing package.
