#!/usr/bin/env Rscript
# Smoke test for the R `methylclock` package.
#
# Fully self-contained: no input files, NO network. methylclock computes
# epigenetic ("DNA-methylation") age from a beta matrix using published clocks
# (Horvath, Hannum, ...). This test is deliberately MODEST: a real age
# computation is NOT meaningfully testable offline with synthetic data (see
# FLAGS), so we assert the package loads and its core API surface is present.
# Exits 0 only if every check passes, so it works as a pass/fail validator:
#
#   Rscript methylclock.R
#
# ============================ WHY MODEST — RE-CHECK =========================
# What a FULL test would need but CANNOT be done blind/offline here:
#   * DNAmAge(x) expects a beta matrix/data.frame whose ROWNAMES are real CpG
#     probe ids that MATCH each clock's coefficient set (the Horvath/Hannum/...
#     CpGs). Synthetic random `cg########` ids match NOTHING, so no clock can be
#     evaluated and the result is empty/meaningless. A genuine test needs a real
#     beta matrix covering the clock CpGs.
#   * The clock COEFFICIENTS ship in a companion data package (`methylclockData`)
#     that DNAmAge pulls from; if absent, a full run cannot proceed offline.
# So the checks below are EXISTENCE + type of the exported entry points, plus a
# SOFT inventory of any datasets bundled with the package. If DNAmAge/checkClocks
# were renamed, the corresponding `::` lookup fails — that is the signal.
# ============================================================================

if (!requireNamespace("methylclock", quietly = TRUE)) {
  cat("FAIL: package 'methylclock' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(methylclock))
cat(sprintf("methylclock version: %s\n", as.character(packageVersion("methylclock"))))

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

run_test("DNAmAge is an exported function", function() {
  stopifnot(is.function(methylclock::DNAmAge))
})

run_test("checkClocks is an exported function", function() {
  stopifnot(is.function(methylclock::checkClocks))
})

run_test("DNAmAge takes a data input as its first argument (SOFT)", function() {
  # Structural sanity only — DNAmAge's first formal is the methylation beta
  # object. Kept SOFT because the exact formal name varies across versions.
  fmls <- tryCatch(names(formals(methylclock::DNAmAge)), error = function(e) character(0))
  if (length(fmls) == 0L) {
    cat("  note could not introspect DNAmAge() formals\n")
    return(invisible(NULL))
  }
  cat(sprintf("  note DNAmAge() first arg is `%s` (feed a beta matrix keyed by clock CpGs)\n",
              fmls[[1]]))
})

run_test("bundled datasets inventory (SOFT)", function() {
  # If the package (or a loaded companion) ships example/coefficient objects
  # offline, report them; do NOT guess names or assert on contents.
  ds <- tryCatch(utils::data(package = "methylclock")$results, error = function(e) NULL)
  n <- if (is.null(ds)) 0L else nrow(ds)
  if (n == 0L) {
    cat("  note no datasets bundled with methylclock itself (coefficients likely in methylclockData)\n")
  } else {
    cat(sprintf("  note methylclock bundles %d dataset(s): %s\n",
                n, paste(utils::head(ds[, "Item"], 5L), collapse = ", ")))
  }
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all methylclock smoke tests passed\n")
