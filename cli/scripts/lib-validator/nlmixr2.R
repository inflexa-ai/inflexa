#!/usr/bin/env Rscript
# Smoke test for the R `nlmixr2` package (population PK/PD NLME modeling).
#
# Fully self-contained: no input files, no network, no packages beyond nlmixr2
# itself -- BUT nlmixr2 compiles models via rxode2, so a working C++ toolchain
# is required at run time (intrinsic to nlmixr2, not a network dependency). The
# test is deliberately MODEST: it defines a one-compartment model with the
# nlmixr2 function/ini/model DSL, parses it into a model object, and runs ONE
# small bounded fit on a fixed-seed simulated dataset. Exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript nlmixr2.R
#
# NOTE (needs re-check once installed): the nlmixr2 model DSL
# (function(){ ini({...}); model({...}) }, linCmt(), add(...)), the parsed-model
# class ("rxUi"), the fit class ("nlmixr2FitData"), and the fit accessors
# (fixef, $objf) were written from the documented API and NOT verified against
# an installed build -- re-confirm all of these when the package is available.
# Fits are heavy and stochastic, so checks assert structural/robust properties
# (classes, finiteness) with bounded iterations -- never exact estimates.

if (!requireNamespace("nlmixr2", quietly = TRUE)) {
  cat("FAIL: package 'nlmixr2' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(nlmixr2))
cat(sprintf("nlmixr2 version: %s\n", as.character(packageVersion("nlmixr2"))))

failures <- 0L
run_test <- function(name, fn) {
  result <- tryCatch({
    fn()
    "ok"
  }, error = function(e) conditionMessage(e))
  if (identical(result, "ok")) {
    cat(sprintf("  ok   %s\n", name))
  } else {
    failures <<- failures + 1L
    cat(sprintf("  FAIL %s: %s\n", name, result))
  }
}

# One-compartment first-order-absorption model in the nlmixr2 DSL: fixed effects
# on log ka/cl/v, a per-subject random effect on each, additive residual error.
one_cmt <- function() {
  ini({
    tka <- 0.45      # log ka
    tcl <- 1.0       # log cl
    tv  <- 3.45      # log v
    add.sd <- 0.7    # additive residual sd
    eta.ka ~ 0.1
    eta.cl ~ 0.1
    eta.v  ~ 0.1
  })
  model({
    ka <- exp(tka + eta.ka)
    cl <- exp(tcl + eta.cl)
    v  <- exp(tv + eta.v)
    linCmt() ~ add(add.sd)
  })
}

# Fixed-seed simulated oral PK dataset (analytic one-compartment solution plus
# subject-level and residual noise). Minimal nlmixr2 event format: an evid==1
# dosing record per subject followed by evid==0 concentration observations.
make_data <- function() {
  set.seed(42)
  n_id <- 6L
  ka <- 1.5; cl <- 2.7; v <- 31.5; ke <- cl / v
  dose <- 100
  times <- c(0.5, 1, 2, 4, 8, 12, 24)
  parts <- list()
  for (id in seq_len(n_id)) {
    dosing <- data.frame(id = id, time = 0, amt = dose, evid = 1L, dv = 0)
    conc <- (dose * ka) / (v * (ka - ke)) * (exp(-ke * times) - exp(-ka * times))
    conc <- conc * exp(rnorm(1L, 0, 0.1))             # between-subject variation
    conc <- pmax(conc + rnorm(length(times), 0, 0.05), 1e-3) # residual, positive
    obs <- data.frame(id = id, time = times, amt = 0, evid = 0L, dv = conc)
    parts[[length(parts) + 1L]] <- rbind(dosing, obs)
  }
  do.call(rbind, parts)
}

run_test("model definition is a function", function() {
  # a syntactically valid nlmixr2 model is an ordinary R function carrying the
  # ini()/model() blocks; this validates the DSL parses at the R level
  stopifnot(is.function(one_cmt))
})

run_test("nlmixr2 parses the model into a UI object", function() {
  ui <- nlmixr2(one_cmt)
  stopifnot(!is.null(ui))
  # the parsed model is an rxode2 UI object
  stopifnot(inherits(ui, "rxUi"))
})

run_test("parsed model exposes its fixed-effect names", function() {
  ui <- nlmixr2(one_cmt)
  ini_df <- ui$iniDf
  stopifnot(is.data.frame(ini_df))
  # the declared population parameters survive parsing
  stopifnot(all(c("tka", "tcl", "tv") %in% ini_df$name))
})

run_test("simulated dataset has the expected event structure", function() {
  dat <- make_data()
  stopifnot(is.data.frame(dat))
  stopifnot(all(c("id", "time", "amt", "evid", "dv") %in% names(dat)))
  # exactly one dosing record per subject, plus observations
  stopifnot(sum(dat$evid == 1L) == 6L)
  stopifnot(sum(dat$evid == 0L) > 0L)
  stopifnot(all(is.finite(dat$dv)), all(dat$dv[dat$evid == 0L] > 0))
})

run_test("a small bounded focei fit converges to finite estimates", function() {
  dat <- make_data()
  # bound the optimizer so the smoke test stays quick; silence progress output.
  ctl <- foceiControl(print = 0L, maxOuterIterations = 20L,
                      maxInnerIterations = 20L)
  fit <- suppressWarnings(nlmixr2(one_cmt, dat, est = "focei", control = ctl))
  stopifnot(inherits(fit, "nlmixr2FitData"))
  fe <- fixef(fit)
  stopifnot(length(fe) >= 3L, all(is.finite(fe)))
  # the objective function value is a finite number
  stopifnot(is.finite(as.numeric(fit$objf)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all nlmixr2 smoke tests passed\n")
