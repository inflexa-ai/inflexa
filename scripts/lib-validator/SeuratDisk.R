#!/usr/bin/env Rscript
# Smoke test for the R `SeuratDisk` package (h5Seurat / .h5ad conversion).
#
# Install: remotes::install_github("mojaveazure/seurat-disk")
#
# Fully self-contained and OFFLINE: no input files, no network. A real round-trip
# -- SaveH5Seurat(object, filename) -> LoadH5Seurat(filename), or Convert(source,
# dest) between .h5Seurat and .h5ad -- needs a Seurat object (full Seurat, not
# blind-installable), the hdf5r backend, and a tempfile on disk, all out of scope
# here. So this validator exercises only the side-effect-free surface: that the
# public entry points and the R6 class generators load and are exported. Exits 0
# only if every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript SeuratDisk.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL -- confirm all of the following once SeuratDisk
# is available:
#   - SaveH5Seurat(object, filename) / LoadH5Seurat(filename) are the on-disk
#     round-trip. A real round-trip needs a Seurat object + hdf5r + a tempfile --
#     out of scope offline; only existence as functions is checked here.
#   - Convert(source, dest) converts between .h5Seurat and .h5ad (AnnData). Same
#     dependency chain (hdf5r + real files); checked only as an exported function.
#   - R6 CLASS GENERATORS. SeuratDisk exports `scdisk` (the abstract HDF5-backed
#     base) and `h5Seurat` (the concrete .h5Seurat handle) as R6ClassGenerator
#     objects. The check below tolerates either being absent from the export list
#     (older/renamed builds) -- re-confirm both the names and that they are
#     exported R6 generators (class "R6ClassGenerator") against the installed
#     package before relying on the class assertions.
# ============================================================================

if (!requireNamespace("SeuratDisk", quietly = TRUE)) {
  cat("FAIL: package 'SeuratDisk' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(SeuratDisk))
cat(sprintf("SeuratDisk version: %s\n", as.character(packageVersion("SeuratDisk"))))

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

run_test("SaveH5Seurat is an exported function", function() {
  # A real SaveH5Seurat(object, filename) needs a Seurat object + hdf5r + a
  # tempfile -- out of scope offline; existence is all we can assert.
  stopifnot(is.function(SaveH5Seurat))
})

run_test("LoadH5Seurat is an exported function", function() {
  stopifnot(is.function(LoadH5Seurat))
})

run_test("Convert is an exported function", function() {
  # .h5Seurat <-> .h5ad conversion; same hdf5r + real-file dependency.
  stopifnot(is.function(Convert))
})

run_test("h5Seurat / scdisk R6 class generators are exported", function() {
  # Both are exported as R6ClassGenerator objects (scdisk is the abstract base,
  # h5Seurat the concrete handle). Export status is version-dependent (see the
  # R6 CLASS GENERATORS note above), so pull each via getExportedValue() and only
  # assert its class when the name is actually exported.
  exports <- getNamespaceExports("SeuratDisk")
  stopifnot("h5Seurat" %in% exports || "scdisk" %in% exports)
  for (nm in intersect(c("h5Seurat", "scdisk"), exports)) {
    gen <- getExportedValue("SeuratDisk", nm)
    stopifnot(inherits(gen, "R6ClassGenerator"))
  }
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all SeuratDisk smoke tests passed\n")
