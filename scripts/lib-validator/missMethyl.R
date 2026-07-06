#!/usr/bin/env Rscript
# Smoke test for the R `missMethyl` package.
#
# Fully self-contained: no input files, NO network. missMethyl provides GO/GSEA
# enrichment for methylation arrays (`gometh`/`gsameth`) and SWAN normalization.
# This test is deliberately MODEST: the load-bearing enrichment and
# normalization paths are NOT meaningfully exercisable offline (see FLAGS), so
# we assert the package loads and its core API surface is present. Exits 0 only
# if every check passes, so it works as a pass/fail validator:
#
#   Rscript missMethyl.R
#
# ============================ WHY MODEST — RE-CHECK ==========================
# What a FULL test would need but CANNOT be done blind/offline here:
#   * gometh()/gsameth() need a 450K/EPIC array-annotation package
#     (IlluminaHumanMethylation450kanno.* / ...EPICanno.*) to map CpG probe ids
#     to genes, PLUS a gene universe (`all.cpg`) of real probe ids. Synthetic
#     `cg########` ids won't map, so any enrichment result is meaningless.
#   * SWAN() normalizes a MethylSet/RGChannelSet (minfi objects) built from IDAT
#     intensities or a bundled minfi example dataset — out of scope offline.
# So the checks below are EXISTENCE + type of the exported entry points. If any
# were renamed, the corresponding `::` lookup fails — that is the signal.
# ============================================================================

if (!requireNamespace("missMethyl", quietly = TRUE)) {
  cat("FAIL: package 'missMethyl' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(missMethyl))
cat(sprintf("missMethyl version: %s\n", as.character(packageVersion("missMethyl"))))

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

run_test("gometh is an exported function", function() {
  stopifnot(is.function(missMethyl::gometh))
})

run_test("gsameth is an exported function", function() {
  stopifnot(is.function(missMethyl::gsameth))
})

run_test("SWAN is an exported function/generic", function() {
  # SWAN is exported as an S4 generic in recent versions; both is.function and
  # existsMethod-style dispatch resolve `SWAN` — treat either as present.
  stopifnot(is.function(missMethyl::SWAN) ||
              methods::existsFunction("SWAN", where = asNamespace("missMethyl")))
})

run_test("getMappedEntrezIDs is an exported function", function() {
  stopifnot(is.function(missMethyl::getMappedEntrezIDs))
})

run_test("gometh exposes the array-type / collection knobs (SOFT)", function() {
  # Structural sanity on the signature; kept SOFT because argument names can
  # drift across versions and this is not a load-bearing correctness check.
  fmls <- tryCatch(names(formals(missMethyl::gometh)), error = function(e) character(0))
  if (length(fmls) == 0L) {
    cat("  note could not introspect gometh() formals\n")
    return(invisible(NULL))
  }
  if (!("array.type" %in% fmls)) {
    cat(sprintf("  note gometh() has no `array.type` arg (formals: %s) -- verify\n",
                paste(fmls, collapse = ", ")))
  }
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all missMethyl smoke tests passed\n")
