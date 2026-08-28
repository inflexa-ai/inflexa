# CPU-quota visibility for R in Inflexa sandbox containers.
#
# `parallel::detectCores()` reads /sys/devices/system/cpu/online, which
# describes the machine. A cgroup CPU quota does not change that file, and
# neither does a cpuset, and neither does any environment value. Thus R is the
# one runtime in this image that reports the cores of the host whatever the
# container is limited to.
#
# Code that sizes a worker pool from detectCores() then forks one worker for
# each core of the host. Each fork copies its working set, thus the forks
# exhaust the memory limit of the container before the CPU limit throttles them.
#
# sandbox-server publishes the quota of the container as INFLEXA_CPU_LIMIT, and
# this profile makes detectCores() report it. Nothing else changes here. In
# particular `mc.cores` stays unset, because R defaults mclapply to 2 workers,
# and that default is R's own and not a count of the host.
#
# Loaded before user code when R_PROFILE_USER points to this file.

local({
  n <- suppressWarnings(as.integer(Sys.getenv("INFLEXA_CPU_LIMIT", "")))
  if (is.na(n) || n < 1L) return(invisible(NULL))

  # The signature must match the one it replaces: a caller can pass either
  # argument, and both are ignored here because the quota counts logical cores.
  replace <- function(...) {
    ns <- asNamespace("parallel")
    tryCatch({
      unlockBinding("detectCores", ns)
      assign("detectCores", function(all.tests = FALSE, logical = TRUE) n, envir = ns)
      lockBinding("detectCores", ns)
    }, error = function(e) invisible(NULL))
  }

  # `parallel` is a base package that loads on demand, thus the hook covers the
  # usual path. The direct call covers a profile that runs after something else
  # already loaded it.
  setHook(packageEvent("parallel", "onLoad"), replace)
  if (isNamespaceLoaded("parallel")) replace()
})
