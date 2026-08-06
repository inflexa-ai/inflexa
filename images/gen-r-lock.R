#!/usr/bin/env Rscript
# Resolve the R bulk track (CRAN + Bioconductor + pinned git packages) into a pak
# lockfile, install it, and split the result into the r/cran and r/bioconductor
# subtrees that the store and the managed mount expect.
#
# The lock is generated here, in the build, rather than checked in: a pak lockfile
# records a per-package platform, so one lock cannot serve both build arches. The
# base image pins a dated P3M snapshot, so an in-build resolve is still reproducible
# — it returns the same versions on every build of the same base digest.
#
# GitHub is NOT resolved here. The GitHub set does not solve as one global lock
# (it needs Remotes: following, and it pins recommended packages against the base),
# so it installs incrementally in a later stage, on top of what this produces.
#
# Usage: gen-r-lock.R <manifest.yaml> <lib_root> [<lock_out>]
#   R_NCPUS (env, optional) caps source-compile parallelism.

args     <- commandArgs(trailingOnly = TRUE)
manifest <- args[1]
lib_root <- args[2]
lock_out <- if (length(args) >= 3) args[3] else file.path(lib_root, "r", "r-bulk.lock")

ncpus <- suppressWarnings(as.integer(Sys.getenv("R_NCPUS", "")))
if (!is.na(ncpus) && ncpus > 0) {
  options(Ncpus = ncpus)
  Sys.setenv(MAKEFLAGS = paste0("-j", ncpus))
}

m <- yaml::read_yaml(manifest)
r <- m$r

cran_refs <- as.character(r$cran)
bioc_refs <- paste0("bioc::", as.character(r$bioconductor))   # DEP already left this list
git_refs  <- vapply(r$git, function(g) sprintf("git::%s@%s", g$url, g$commit), character(1))
bulk_refs <- c(cran_refs, bioc_refs, git_refs)
message(sprintf("bulk refs: %d CRAN + %d Bioc + %d git = %d",
                length(cran_refs), length(bioc_refs), length(git_refs), length(bulk_refs)))

dir.create(dirname(lock_out), recursive = TRUE, showWarnings = FALSE)
pak::lockfile_create(bulk_refs, lockfile = lock_out)

# Stage inside the store subtree so the later file.rename stays on one filesystem
# (a cross-device rename fails with EXDEV).
stage <- file.path(lib_root, "r", ".stage")
unlink(stage, recursive = TRUE); dir.create(stage, recursive = TRUE)

# Install best-effort. pak::lockfile_install aborts the whole install if any single
# package fails to build, but the sandbox contract is best-effort per package — the
# per-track load check is the floor. So catch the abort, keep whatever did install,
# and let the load check report the drops. A failure here is usually a resource limit
# (a large annotation package OOMing its load test), not a broken package. pak also
# installs the missing apt system libraries itself along the way.
install_err <- tryCatch({ pak::lockfile_install(lock_out, lib = stage); NULL },
                        error = function(e) conditionMessage(e))
if (!is.null(install_err))
  message("WARNING: lockfile_install did not finish cleanly: ", install_err,
          "\n  keeping the packages that did install; the load check is the gate.")

# Subtree key is REACHABILITY, not the lock `type`: pak types a Bioconductor package
# `standard` when P3M's standard repo mirrors it, so `type` cannot separate the two.
# r/cran gets the closure of the CRAN refs — exactly what the old CRAN stage installed
# before Bioc ran; everything else installed goes to r/bioconductor.
cran_members <- unique(pak::pkg_deps(cran_refs, dependencies = NA)$package)
cran_dir <- file.path(lib_root, "r", "cran")
bioc_dir <- file.path(lib_root, "r", "bioconductor")
dir.create(cran_dir, recursive = TRUE, showWarnings = FALSE)
dir.create(bioc_dir, recursive = TRUE, showWarnings = FALSE)

installed <- list.dirs(stage, recursive = FALSE, full.names = FALSE)
installed <- installed[file.exists(file.path(stage, installed, "DESCRIPTION"))]
n_cran <- 0L; n_bioc <- 0L
for (pkg in installed) {
  dest <- if (pkg %in% cran_members) cran_dir else bioc_dir
  if (!file.rename(file.path(stage, pkg), file.path(dest, pkg)))
    stop(sprintf("failed to place %s into %s", pkg, dest))
  if (identical(dest, cran_dir)) n_cran <- n_cran + 1L else n_bioc <- n_bioc + 1L
}
unlink(stage, recursive = TRUE)
message(sprintf("placed %d packages: %d -> r/cran, %d -> r/bioconductor",
                length(installed), n_cran, n_bioc))
if (length(installed) == 0) stop("no R packages installed from the bulk lock")
