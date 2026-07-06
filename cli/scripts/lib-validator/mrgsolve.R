#!/usr/bin/env Rscript
# Smoke test for the R `mrgsolve` package.
#
# Fully self-contained: no input files, no network, no packages beyond mrgsolve
# itself -- BUT it compiles an ODE model from an inline code block, so a working
# C++ toolchain is required at run time (that is intrinsic to mrgsolve, not a
# network dependency). Exercises the compile -> dose -> simulate path for a
# one-compartment IV-bolus PK model and exits 0 only if every check passes, so
# it can be used as a pass/fail library validator:
#
#   Rscript mrgsolve.R
#
# NOTE (needs re-check once installed): the model-DSL block ($PARAM/$CMT/$ODE/
# $CAPTURE) and the mcode/mrgsim/ev entry points were written from the
# documented API and NOT verified against an installed build -- re-confirm the
# DSL and simulation accessors when the package is available. Simulated
# concentrations are floating point, so checks assert structural/robust
# properties (class, finiteness, non-negativity, monotone decay after the dose)
# -- never exact equality.

if (!requireNamespace("mrgsolve", quietly = TRUE)) {
  cat("FAIL: package 'mrgsolve' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(mrgsolve))
cat(sprintf("mrgsolve version: %s\n", as.character(packageVersion("mrgsolve"))))

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

# One-compartment IV-bolus model: first-order elimination from a single central
# compartment, capturing concentration CP = amount / volume. mrgsolve caches the
# compiled shared object by model name, so repeated make_mod() calls recompile
# only once.
model_code <- paste(
  "$PARAM CL=1, V=20",
  "$CMT CENT",
  "$ODE dxdt_CENT = -(CL/V)*CENT;",
  "$CAPTURE CP=CENT/V",
  sep = "\n"
)
make_mod <- function() {
  mcode("onecmt_iv", model_code)
}

run_test("mcode compiles the ODE model", function() {
  mod <- make_mod()
  stopifnot(inherits(mod, "mrgmod"))
})

run_test("ev builds an event object", function() {
  dose <- ev(amt = 100)
  stopifnot(inherits(dose, "ev"))
})

run_test("mrgsim returns simulated output", function() {
  mod <- make_mod()
  out <- mrgsim(mod, events = ev(amt = 100), end = 24)
  stopifnot(inherits(out, "mrgsims"))
  df <- as.data.frame(out)
  stopifnot(is.data.frame(df), nrow(df) > 1L)
  # the captured concentration column is present
  stopifnot("CP" %in% names(df))
})

run_test("concentrations are finite and non-negative", function() {
  mod <- make_mod()
  df <- as.data.frame(mrgsim(mod, events = ev(amt = 100), end = 24))
  cp <- df$CP
  stopifnot(all(is.finite(cp)))
  stopifnot(all(cp >= -1e-9))
  # the dose actually put drug in the system
  stopifnot(max(cp) > 0)
})

run_test("concentration decays monotonically after the dose", function() {
  mod <- make_mod()
  df <- as.data.frame(mrgsim(mod, events = ev(amt = 100), end = 24))
  cp <- df$CP
  # the peak follows the bolus immediately; everything after it must not rise
  peak <- which.max(cp)
  stopifnot(peak <= 2L)
  tail_cp <- cp[peak:length(cp)]
  stopifnot(all(diff(tail_cp) <= 1e-6))
  # first-order elimination -> concentration approaches zero by the horizon
  stopifnot(tail_cp[length(tail_cp)] < max(cp))
})

run_test("larger dose scales the exposure", function() {
  mod <- make_mod()
  lo <- as.data.frame(mrgsim(mod, events = ev(amt = 100), end = 24))$CP
  hi <- as.data.frame(mrgsim(mod, events = ev(amt = 200), end = 24))$CP
  # a linear one-compartment model: doubling the dose raises peak concentration
  stopifnot(max(hi) > max(lo))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all mrgsolve smoke tests passed\n")
