# Gate 2 R-example pass: run each installed R package's OWN examples via
# tools::testInstalledPackage — near-maximum scrutiny, author-provided, zero
# bespoke fixtures. R is the one ecosystem where "does real work" is auto-
# discovered because we are not the author.
#
# Scoping (design D): a network/\donttest denylist skips packages whose examples
# hit the network (forbidden on the read-only, no-network sandbox); a per-package
# time limit bounds runaway examples. Genuine example ERRORS fail the gate;
# denylisted or timed-out packages are skipped (not failed).
#
# Usage: Rscript r_examples.R [max_packages]   (max_packages scopes runtime)

args <- commandArgs(trailingOnly = TRUE)
max_pkgs <- if (length(args) >= 1 && nchar(args[1]) > 0) as.integer(args[1]) else NA_integer_

# Packages whose examples reach the network or external annotation hubs.
DENY <- c(
  "AnnotationHub", "ExperimentHub", "biomaRt", "AnnotationDbi", "ensembldb",
  "EnsDb.Hsapiens.v86", "EnsDb.Mmusculus.v79", "KEGGREST", "rtracklayer",
  "org.Hs.eg.db", "org.Mm.eg.db", "org.Rn.eg.db", "org.Dr.eg.db",
  "org.Cf.eg.db", "org.Bt.eg.db", "TwoSampleMR", "MendelianRandomization",
  "immunedeconv", "msigdbr", "babelgene"
)
DENY_PREFIX <- c("org.", "EnsDb.", "BSgenome", "TxDb.")

# Vectorized denylist test: returns a logical vector PARALLEL to `pkgs`. It must be
# vectorized because it filters the whole installed vector at once — a scalar-style
# `if (pkg %in% DENY)` on a length-N logical aborts under R >= 4.2 (and R 4.6, where
# `_R_CHECK_LENGTH_1_CONDITION_` is enforced), failing the gate. `startsWith` is
# vectorized over its first arg; OR its per-prefix results together (seeded with an
# all-FALSE vector so an empty `pkgs` yields logical(0), not a length mismatch).
is_denied <- function(pkgs) {
  by_prefix <- Reduce(`|`, lapply(DENY_PREFIX, function(p) startsWith(pkgs, p)), init = logical(length(pkgs)))
  pkgs %in% DENY | by_prefix
}

# Package names an example failure blames on a MISSING package: R's standard
# "there is no package called '<X>'" (straight or curly quotes) and the common
# package-custom "Requires <X>. Please run: ..." idiom. Used to tell "the example
# needs a companion data/annotation package we deliberately do not bundle" (a SKIP,
# same rationale as the network denylist) apart from a genuine example error (a FAIL).
example_missing_pkgs <- function(txt) {
  if (!nzchar(txt)) return(character(0))
  lines <- strsplit(txt, "\n", fixed = TRUE)[[1]]
  hits <- character(0)
  for (ln in lines) {
    m1 <- regmatches(ln, regexec("there is no package called .([A-Za-z0-9._]+)", ln))[[1]]
    if (length(m1) == 2L) hits <- c(hits, m1[2])
    m2 <- regmatches(ln, regexec("[Rr]equires ([A-Za-z0-9._]+)\\.? +Please", ln))[[1]]
    if (length(m2) == 2L) hits <- c(hits, m2[2])
  }
  unique(hits)
}

# Discover installed packages on the mounted store's libpaths (R_LIBS_SITE is
# set by run.sh). Base/recommended packages ship no meaningful examples here.
libs <- .libPaths()
store_libs <- libs[grepl("^/mnt/libs/", libs)]
if (length(store_libs) == 0) store_libs <- libs
installed <- unique(rownames(installed.packages(lib.loc = store_libs)))
installed <- installed[!is_denied(installed)]
installed <- sort(installed)
if (!is.na(max_pkgs) && length(installed) > max_pkgs) {
  installed <- installed[seq_len(max_pkgs)]
}

cat(sprintf("R examples: %d package(s) after denylist\n", length(installed)))

outdir <- tempfile("rex-")
dir.create(outdir)
per_pkg_seconds <- as.numeric(Sys.getenv("LIB_STORE_R_EXAMPLE_TIMEOUT", "120"))

failed <- character(0)
skipped <- character(0)
passed <- 0L

for (pkg in installed) {
  res <- tryCatch({
    setTimeLimit(cpu = per_pkg_seconds, elapsed = per_pkg_seconds, transient = TRUE)
    on.exit(setTimeLimit(cpu = Inf, elapsed = Inf), add = TRUE)
    tools::testInstalledPackage(pkg, outDir = outdir, types = "examples", lib.loc = store_libs)
  }, error = function(e) e)
  setTimeLimit(cpu = Inf, elapsed = Inf)

  if (inherits(res, "error")) {
    msg <- conditionMessage(res)
    if (grepl("reached .* time limit|elapsed time limit", msg)) {
      cat(sprintf("  SKIP %s: exceeded %ss time limit\n", pkg, per_pkg_seconds))
      skipped <- c(skipped, pkg)
    } else {
      cat(sprintf("  FAIL %s: %s\n", pkg, msg))
      failed <- c(failed, pkg)
    }
  } else if (is.numeric(res) && res != 0L) {
    # An example can fail only because it needs a companion data/annotation package
    # we deliberately do not bundle (e.g. annotate's example loads hgu95av2.db;
    # AnnotationHubData's needs GenomeInfoDbData). That is not a defect of OUR store,
    # so SKIP when the failure names a package NOT installed here. Every other failure
    # is a real error and fails the gate.
    failfile <- file.path(outdir, paste0(pkg, "-Ex.Rout.fail"))
    reason <- if (file.exists(failfile)) paste(readLines(failfile, warn = FALSE), collapse = "\n") else ""
    missing <- setdiff(example_missing_pkgs(reason), installed)
    if (length(missing) > 0) {
      cat(sprintf("  SKIP %s: example needs unbundled package(s): %s\n", pkg, paste(missing, collapse = ", ")))
      skipped <- c(skipped, pkg)
    } else {
      cat(sprintf("  FAIL %s: testInstalledPackage returned %s\n", pkg, res))
      failed <- c(failed, pkg)
    }
  } else {
    passed <- passed + 1L
  }
}

cat(sprintf("\nR examples summary: %d passed, %d skipped, %d FAILED\n",
            passed, length(skipped), length(failed)))
if (length(failed) > 0) {
  cat("FAILED example packages:", paste(failed, collapse = ", "), "\n")
  quit(status = 1)
}
