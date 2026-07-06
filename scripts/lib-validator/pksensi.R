#!/usr/bin/env Rscript
# Smoke test for the R `pksensi` package.
#
# Fully self-contained: no input files, no network, no compiled model. Exercises
# the global-sensitivity workflow on a simple analytic one-compartment oral PK
# model instead of a compiled ODE: draw an eFAST parameter sample with
# rfast99(), evaluate the closed-form concentration over the sample, feed the
# responses back with tell2(), and inspect the sensitivity indices. Checks are
# structural / range-based (object classes, finiteness, indices in a sane band)
# -- never exact numeric equality on the stochastic sampler. Exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript pksensi.R
#
# NOTE (needs re-check once installed): this is the HIGH-UNCERTAINTY script of
# the set. The eFAST sampler entry point (rfast99), the layout of its sample
# array `x$a`, the shape tell2() expects for the response array
# (c(evaluations, replications, times, outputs)), and the index slots
# (x$mSI main / x$iSI interaction / x$tSI total) were written from the
# documented API and NOT verified against an installed build. The model-over-
# sample step locates the parameter dimension via `dimnames(x$a)` so it does not
# hard-code which axis holds the parameters, and every stage is wrapped in
# run_test() so a shape/name mismatch fails that one check cleanly instead of
# crashing. Re-confirm rfast99 / tell2 / the index accessors when the package
# is available.

if (!requireNamespace("pksensi", quietly = TRUE)) {
  cat("FAIL: package 'pksensi' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(pksensi))
cat(sprintf("pksensi version: %s\n", as.character(packageVersion("pksensi"))))

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

# One-compartment oral PK model. Parameters: ka (absorption rate), ke
# (elimination rate), V (volume of distribution). Uniform priors keep ka well
# above ke over the whole box, so ka - ke never approaches zero and the
# closed-form concentration stays finite and positive.
params <- c("ka", "ke", "V")
q <- "qunif"
q.arg <- list(
  list(min = 0.5, max = 1.5),   # ka
  list(min = 0.05, max = 0.2),  # ke
  list(min = 10, max = 30)      # V
)

# Analytic plasma concentration after a single oral dose (F = 1) at a fixed time.
conc_1cpt <- function(ka, ke, V, dose = 100, t = 2) {
  (dose * ka) / (V * (ka - ke)) * (exp(-ke * t) - exp(-ka * t))
}

# Draw the eFAST sample once; reuse it across the workflow tests.
set.seed(1234)
sample_obj <- rfast99(
  params = params, n = 100, q = q, q.arg = q.arg, replicate = 1
)

run_test("rfast99 builds an eFAST sample", function() {
  stopifnot(inherits(sample_obj, "rfast99"))
  a <- sample_obj$a
  stopifnot(is.array(a) || is.matrix(a))
  stopifnot(all(is.finite(a)))
  # The parameter axis must carry our three parameter names.
  pdim <- which(vapply(
    dimnames(a),
    function(z) !is.null(z) && all(params %in% z),
    logical(1)
  ))
  stopifnot(length(pdim) == 1L)
  stopifnot(dim(a)[pdim] == length(params))
})

run_test("tell2 computes sensitivity indices from the model responses", function() {
  x <- sample_obj
  a <- x$a
  d <- dim(a)

  # Locate the parameter axis by name, move it last, and flatten the remaining
  # (sample x replicate) axes into rows so each row is one full parameter set.
  pdim <- which(vapply(
    dimnames(a),
    function(z) !is.null(z) && all(params %in% z),
    logical(1)
  ))
  stopifnot(length(pdim) == 1L)
  perm <- c(setdiff(seq_along(d), pdim), pdim)
  A <- aperm(a, perm)
  k <- d[pdim]
  n_run <- prod(d[-pdim])
  Amat <- matrix(A, nrow = n_run, ncol = k)
  colnames(Amat) <- dimnames(a)[[pdim]]

  # Evaluate the analytic model row-wise.
  y_vec <- conc_1cpt(Amat[, "ka"], Amat[, "ke"], Amat[, "V"])
  stopifnot(all(is.finite(y_vec)), all(y_vec > 0))

  # tell2 expects the response as c(evaluations, replications, times, outputs);
  # our single time / single output add two trailing length-1 axes. The row
  # order of y_vec (sample fastest, then replicate) matches this fill order.
  y <- array(y_vec, dim = c(d[-pdim], 1L, 1L))
  x <- tell2(x, y)

  # Main (first-order) and total sensitivity indices must be finite and land in
  # a sane band: indices are variance fractions, nominally in [0, 1], but eFAST
  # estimates can overshoot slightly on a small sample -- allow a margin.
  stopifnot(!is.null(x$mSI), all(is.finite(x$mSI)))
  stopifnot(!is.null(x$tSI), all(is.finite(x$tSI)))
  stopifnot(all(x$mSI >= -0.1), all(x$mSI <= 1.5))
  stopifnot(all(x$tSI >= -0.1), all(x$tSI <= 1.5))
  # Interaction indices, when present, should also be finite.
  if (!is.null(x$iSI)) {
    stopifnot(all(is.finite(x$iSI)))
  }
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all pksensi smoke tests passed\n")
