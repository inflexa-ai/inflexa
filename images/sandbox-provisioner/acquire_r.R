#!/usr/bin/env Rscript
# The incremental R acquire helper of the provisioner. Three modes, one per
# invocation:
#
#   probe <names.json>
#       For each name, report if CRAN or Bioconductor holds it. Prints one
#       JSON object {name: true/false} as the last line of stdout. The
#       both-hit stop of `provision acquire` reads it.
#
#   resolve <ref> <lock-out>
#       Resolve one request with pak, against CRAN and Bioconductor only.
#       A bare name tries CRAN first, then bioc::<name>. The lockfile is the
#       resolved closure, and it rides into the acquire report as provenance.
#
#   install <lock.json> <lib>
#       Install the entries of a pak lockfile into <lib>. The caller filters
#       the lock to the entries that the pool does not hold, thus a pool hit
#       never installs again. pak adds the system libraries of each package
#       itself, from its SystemRequirements.

args <- commandArgs(trailingOnly = TRUE)
mode <- args[1]

if (identical(mode, "probe")) {
  names <- jsonlite::fromJSON(args[2], simplifyVector = TRUE)
  out <- list()
  for (name in names) {
    hit <- tryCatch(nrow(pak::meta_list(pkg = name)) > 0,
                    error = function(e) FALSE)
    if (!isTRUE(hit)) {
      hit <- tryCatch({
        pak::pkg_deps(paste0("bioc::", name), dependencies = FALSE)
        TRUE
      }, error = function(e) FALSE)
    }
    out[[name]] <- isTRUE(hit)
  }
  cat(jsonlite::toJSON(out, auto_unbox = TRUE), "\n", sep = "")
} else if (identical(mode, "resolve")) {
  ref <- args[2]
  lock_out <- args[3]
  ok <- tryCatch({
    pak::lockfile_create(ref, lockfile = lock_out)
    TRUE
  }, error = function(e) {
    message(conditionMessage(e))
    FALSE
  })
  if (!ok && !grepl("::", ref, fixed = TRUE)) {
    message(sprintf("CRAN cannot resolve %s; trying Bioconductor", ref))
    ok <- tryCatch({
      pak::lockfile_create(paste0("bioc::", ref), lockfile = lock_out)
      TRUE
    }, error = function(e) {
      message(conditionMessage(e))
      FALSE
    })
  }
  if (!ok) quit(status = 1)
} else if (identical(mode, "install")) {
  lock <- args[2]
  lib <- args[3]
  dir.create(lib, recursive = TRUE, showWarnings = FALSE)
  pak::lockfile_install(lock, lib = lib)
} else {
  stop(sprintf("unknown mode: %s", mode))
}
