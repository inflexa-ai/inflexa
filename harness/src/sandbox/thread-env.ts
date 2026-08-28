/**
 * Thread-count env for a sandbox container.
 *
 * Each backend turns the `ResourceSpec` of a step into a hard cgroup limit:
 * `NanoCpus` and `Memory` on Docker, `limits.cpu` and `limits.memory` on K8s. A
 * cgroup quota is invisible to most runtimes inside it. `parallel::detectCores()`
 * greps `/proc/cpuinfo`, and `os.cpu_count()` reads
 * `/sys/devices/system/cpu/online`. Both files describe the host. Thus a step
 * with 2 CPUs on a host of 12 cores forks 12 workers into a cgroup of 2 CPUs,
 * and each fork copies its working set until the memory limit stops it.
 *
 * The env below publishes the quota to each library that reads a thread count
 * from the environment. `parallelly::availableCores()` and `joblib.cpu_count()`
 * read the cgroup quota on their own, thus they need no value here.
 *
 * `MC_CORES` is absent on purpose. R defaults `mclapply` to 2 workers, not to
 * the core count. A value there raises the fork count instead of a decrease.
 */

import type { ResourceSpec } from "../config/resource-limits.js";

/**
 * Env that binds each parallel library in the container to `spec.cpu`.
 *
 * A fractional CPU request floors to one thread. A pool of zero is not
 * representable, and two threads on half a core only add context switches.
 *
 * The caller puts these before `plan.env` and before the `extraEnv` of the
 * embedder, thus a host that knows more about a step keeps the last word.
 */
export function threadLimitEnv(spec: ResourceSpec): Record<string, string> {
    const threads = String(Math.max(1, Math.floor(spec.cpu)));
    return {
        // OpenMP: the compiled code of R and Python packages.
        OMP_NUM_THREADS: threads,
        // OpenBLAS keeps a private pool. A pthread build reads this name first.
        OPENBLAS_NUM_THREADS: threads,
        // MKL reads this name before OMP_NUM_THREADS.
        MKL_NUM_THREADS: threads,
        // BiocParallel sizes `bpparam()` from this name. DESeq2 `parallel=TRUE`
        // and the other Bioconductor packages size their workers from `bpparam()`.
        BIOCPARALLEL_WORKER_NUMBER: threads,
        // data.table defaults to half of the host cores.
        R_DATATABLE_NUM_THREADS: threads,
        // The Python numerical stack.
        NUMBA_NUM_THREADS: threads,
        NUMEXPR_MAX_THREADS: threads,
        LOKY_MAX_CPU_COUNT: threads,
        POLARS_MAX_THREADS: threads,
        RAYON_NUM_THREADS: threads,
    };
}
