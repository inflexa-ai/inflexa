#!/usr/bin/env Rscript
# Smoke test for the R `mixOmics` package (multivariate / integrative omics).
#
# Fully self-contained: no input files, no network, no packages beyond mixOmics
# itself. Data is a small samples x variables matrix simulated with a fixed
# seed, with a mean shift planted in the first variables of the second class so
# a supervised model has real structure to fit. Checks are structural /
# tolerance-based (object classes, component dimensions, variance-explained
# bounds, that predict() runs), never exact floating-point equality. Exits 0
# only if every check passes, so it can be used as a pass/fail library
# validator:
#
#   Rscript mixOmics.R
#
# FLAG (unverified on this machine -- mixOmics is NOT installed here): the
# result class strings ("pca", "mixo_plsda") and the accessor names
# ($variates$X, $prop_expl_var$X, $loadings) are taken from the documented
# mixOmics API and should be re-checked against the installed version.

if (!requireNamespace("mixOmics", quietly = TRUE)) {
  cat("FAIL: package 'mixOmics' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(mixOmics))
cat(sprintf("mixOmics version: %s\n", as.character(packageVersion("mixOmics"))))

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

# Fixture: 40 samples x 10 variables, two balanced classes. Baseline is
# standard-normal noise; the first 3 variables get a +3 mean shift in class B,
# giving PLS-DA a clear axis of separation to recover.
set.seed(1)
n <- 40L
p <- 10L
n_signal <- 3L
X <- matrix(rnorm(n * p), nrow = n, ncol = p,
            dimnames = list(sprintf("s%02d", seq_len(n)),
                            sprintf("v%02d", seq_len(p))))
Y <- factor(rep(c("A", "B"), each = n / 2L))
X[Y == "B", seq_len(n_signal)] <- X[Y == "B", seq_len(n_signal)] + 3

run_test("pca: object class, component dims, variance explained", function() {
  pr <- mixOmics::pca(X, ncomp = 3)
  stopifnot(inherits(pr, "pca"))
  # $variates$X holds the sample scores: one row per sample, one column per
  # requested component.
  stopifnot(is.matrix(pr$variates$X))
  stopifnot(identical(dim(pr$variates$X), c(n, 3L)))
  # Proportion of variance explained: bounded in [0, 1] per component.
  pev <- pr$prop_expl_var$X
  stopifnot(length(pev) == 3L)
  stopifnot(all(is.finite(pev)), all(pev >= 0), all(pev <= 1 + 1e-8))
})

run_test("pca: loadings shape", function() {
  pr <- mixOmics::pca(X, ncomp = 2)
  # Variable loadings: one row per input variable, one column per component.
  stopifnot(identical(dim(pr$loadings$X), c(p, 2L)))
})

run_test("plsda: supervised model class and scores", function() {
  pl <- mixOmics::plsda(X, Y, ncomp = 2)
  stopifnot(inherits(pl, "mixo_plsda"))
  stopifnot(identical(dim(pl$variates$X), c(n, 2L)))
})

run_test("plsda: predict runs and returns one class per sample", function() {
  pl <- mixOmics::plsda(X, Y, ncomp = 2)
  pred <- predict(pl, newdata = X)
  # max.dist is the default distance; its per-component class assignments form
  # a samples x ncomp matrix. Assert one prediction row per input sample.
  cls <- pred$class$max.dist
  stopifnot(nrow(cls) == n)
  stopifnot(all(as.vector(cls) %in% levels(Y)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all mixOmics smoke tests passed\n")
