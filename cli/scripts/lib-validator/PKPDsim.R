#!/usr/bin/env Rscript
# Smoke test for the R `PKPDsim` package.
#
# Install: remotes::install_github("InsightRX/PKPDsim")
#
# Fully self-contained: no input files, no network, no packages beyond PKPDsim
# itself -- BUT `new_ode_model()` compiles an ODE model to C++ via Rcpp, so a
# working C++ toolchain is required at run time (that is intrinsic to PKPDsim,
# not a network dependency). Exercises the compile -> dose -> simulate path for a
# one-compartment IV-bolus PK model and exits 0 only if every check passes, so
# it can be used as a pass/fail library validator:
#
#   Rscript PKPDsim.R
#
# NOTE (needs re-check once installed): the entry points were written from the
# documented API and NOT verified against an installed build. Re-confirm:
#   * new_ode_model("pk_1cmt_iv") -- the bundled library-model name and the
#     class of the returned object (asserted only non-null here).
#   * new_regimen(amt=, n=, interval=, type="bolus") -- the exact argument names
#     and that a single IV bolus is expressed this way.
#   * sim(ode=, parameters=list(CL=, V=), regimen=, t_obs=, only_obs=TRUE) -- the
#     argument names and the returned long-format columns (time in `t`, the
#     dependent/observation variable in `y`); these column names are guarded by
#     membership checks so a rename fails one test cleanly rather than crashing.
# Simulated concentrations are floating point, so checks assert structural/robust
# properties (class, finiteness, non-negativity, monotone decay after the dose)
# -- never exact equality.

if (!requireNamespace("PKPDsim", quietly = TRUE)) {
  cat("FAIL: package 'PKPDsim' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(PKPDsim))
cat(sprintf("PKPDsim version: %s\n", as.character(packageVersion("PKPDsim"))))

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

# One-compartment IV-bolus model from the bundled PKPDsim library: first-order
# elimination (CL) from a single central compartment of volume V. new_ode_model
# compiles the model to a shared object once; the parameters are supplied per
# sim() call. A single 100-unit bolus is observed at 1..24 h -- every sample
# falls after the t=0 dose, so concentration should decay monotonically.
params <- list(CL = 5, V = 50)
t_obs <- c(1, 2, 4, 8, 24)
make_model <- function() {
  new_ode_model("pk_1cmt_iv")
}
make_regimen <- function(amt) {
  new_regimen(amt = amt, n = 1, interval = 24, type = "bolus")
}
simulate <- function(amt) {
  sim(
    ode = make_model(),
    parameters = params,
    regimen = make_regimen(amt),
    t_obs = t_obs,
    only_obs = TRUE
  )
}

run_test("new_ode_model compiles the library model", function() {
  mod <- make_model()
  stopifnot(!is.null(mod))
})

run_test("new_regimen builds a single IV bolus", function() {
  reg <- make_regimen(100)
  stopifnot(!is.null(reg))
})

run_test("sim returns a data.frame of observations", function() {
  df <- simulate(100)
  stopifnot(is.data.frame(df), nrow(df) > 1L)
  # PKPDsim returns long-format output: time in `t`, dependent variable in `y`
  stopifnot("t" %in% names(df))
  stopifnot("y" %in% names(df))
})

run_test("concentrations are finite and non-negative", function() {
  df <- simulate(100)
  y <- df$y
  stopifnot(all(is.finite(y)))
  stopifnot(all(y >= -1e-9))
  # the dose actually put drug in the system
  stopifnot(max(y) > 0)
})

run_test("concentration decays monotonically after the bolus", function() {
  df <- simulate(100)
  ord <- df[order(df$t), ]
  y <- ord$y
  # all observation times are post-dose, so on a one-compartment IV model the
  # concentration must not rise between successive samples
  stopifnot(all(diff(y) <= 1e-6))
  # first-order elimination -> concentration falls over the horizon
  stopifnot(y[length(y)] < y[1])
})

run_test("larger dose scales the exposure", function() {
  lo <- simulate(100)$y
  hi <- simulate(200)$y
  # a linear one-compartment model: doubling the dose raises peak concentration
  stopifnot(max(hi) > max(lo))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all PKPDsim smoke tests passed\n")
