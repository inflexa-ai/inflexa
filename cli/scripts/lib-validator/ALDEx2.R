#!/usr/bin/env Rscript
# Smoke test for the R `ALDEx2` package (ANOVA-Like Differential Expression /
# CLR-based compositional differential abundance).
#
# Fully self-contained: no input files, no network, no packages beyond ALDEx2
# itself. The reads matrix is simulated with a fixed seed; ALDEx2's Monte-Carlo
# instances make exact values non-deterministic, so every check is structural
# (table shape, required columns, one row per feature) rather than exact
# floating-point equality. Exits 0 only if every check passes, so it can be
# used as a pass/fail library validator:
#
#   Rscript ALDEx2.R
#
# FLAG (orientation): ALDEx2 expects the reads matrix as FEATURES (rows) x
# SAMPLES (columns) -- the transpose of most tidy count tables -- and the
# conditions vector aligns with the COLUMNS. This is the classic ALDEx2
# footgun; the fixture below is oriented that way on purpose.

if (!requireNamespace("ALDEx2", quietly = TRUE)) {
  cat("FAIL: package 'ALDEx2' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(ALDEx2))
cat(sprintf("ALDEx2 version: %s\n", as.character(packageVersion("ALDEx2"))))

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

# Fixture: 100 features (rows) x 10 samples (columns) of Poisson counts, two
# conditions of 5 samples each. A modest number of Monte-Carlo instances keeps
# the run fast while still exercising the full CLR pipeline.
set.seed(1)
n_features <- 100L
n_samples <- 10L
reads <- matrix(
  rpois(n_features * n_samples, lambda = 20),
  nrow = n_features,
  ncol = n_samples,
  dimnames = list(sprintf("f%03d", seq_len(n_features)),
                  sprintf("s%02d", seq_len(n_samples)))
)
conds <- c(rep("A", n_samples / 2L), rep("B", n_samples / 2L))
mc <- 8L

# aldex.clr's per-instance sampling prints a progress line per Monte-Carlo
# draw; suppressMessages keeps the log clean. Genuine errors still propagate.
build_clr <- function() {
  suppressMessages(ALDEx2::aldex.clr(reads, conds, mc.samples = mc, verbose = FALSE))
}

run_test("aldex.clr: builds a CLR object over the feature x sample matrix", function() {
  x <- build_clr()
  stopifnot(!is.null(x))
  # numFeatures / numMCInstances are the documented accessors on the clr object.
  stopifnot(ALDEx2::numFeatures(x) == n_features)
  stopifnot(ALDEx2::numMCInstances(x) == mc)
})

run_test("aldex.ttest: t-test table has we.ep / wi.ep, one row per feature", function() {
  x <- build_clr()
  tt <- ALDEx2::aldex.ttest(x)
  stopifnot(is.data.frame(tt))
  stopifnot(nrow(tt) == n_features)
  stopifnot(all(c("we.ep", "we.eBH", "wi.ep", "wi.eBH") %in% colnames(tt)))
  # p-values are bounded in [0, 1].
  stopifnot(all(tt$we.ep >= 0 & tt$we.ep <= 1))
  stopifnot(all(tt$wi.ep >= 0 & tt$wi.ep <= 1))
})

run_test("aldex.effect: effect table has effect / diff.btw, one row per feature", function() {
  x <- build_clr()
  ef <- ALDEx2::aldex.effect(x)
  stopifnot(is.data.frame(ef))
  stopifnot(nrow(ef) == n_features)
  stopifnot(all(c("effect", "diff.btw", "diff.win") %in% colnames(ef)))
  stopifnot(all(is.finite(ef$effect)))
})

run_test("aldex: one-shot wrapper returns a combined per-feature table", function() {
  res <- suppressMessages(
    ALDEx2::aldex(reads, conds, mc.samples = mc, test = "t", effect = TRUE,
                  verbose = FALSE)
  )
  stopifnot(is.data.frame(res))
  stopifnot(nrow(res) == n_features)
  # The combined table merges the t-test and effect columns.
  stopifnot(all(c("we.ep", "wi.ep", "effect", "diff.btw") %in% colnames(res)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all ALDEx2 smoke tests passed\n")
