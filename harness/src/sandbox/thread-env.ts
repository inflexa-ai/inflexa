/**
 * Thread-count env for a sandbox container.
 *
 * Each backend turns the `ResourceSpec` of a step into a hard cgroup limit:
 * `NanoCpus` and `Memory` on Docker, `limits.cpu` and `limits.memory` on K8s.
 * The mounted cpu files show the quota to `parallel::detectCores()` and to
 * `os.cpu_count()`. Thus the fork count of a step follows the quota by default.
 *
 * The thread pools get a different default. A fork copies the pool size of its
 * parent, and no R runtime divides it. Thus a pool at the quota turns into
 * `workers * quota` threads inside one cgroup. The env below pins each pool to
 * one thread, which is the convention of Snakemake and of the HPC sites. A
 * thread-parallel step raises the value per command, through the `env`
 * parameter of `execute_command`. The rule for the agent is one line: workers
 * times threads must not go above the quota.
 *
 * The two worker-count names stay at the quota. They cap process workers, not
 * threads, and a worker with one thread is safe at each count up to the quota.
 * joblib divides its own budget by its worker count, and a value of one in
 * `OMP_NUM_THREADS` gives each of its workers one thread as well.
 *
 * `MC_CORES` is absent on purpose. R defaults `mclapply` to 2 workers, not to
 * the core count. A value there raises the fork count instead of a decrease.
 */

import type { ResourceSpec } from "../config/resource-limits.js";

/**
 * Env that makes each parallel library in the container safe under `spec.cpu`.
 *
 * A fractional CPU request floors to one worker. A pool of zero is not
 * representable, and two workers on half a core only add context switches.
 *
 * The caller puts these before `plan.env` and before the `extraEnv` of the
 * embedder, thus a host that knows more about a step keeps the last word.
 */
export function threadLimitEnv(spec: ResourceSpec): Record<string, string> {
    const workers = String(Math.max(1, Math.floor(spec.cpu)));
    return {
        // Thread pools: one thread each. The agent raises a value per command.
        // OpenMP: the compiled code of R and Python packages.
        OMP_NUM_THREADS: "1",
        // OpenBLAS keeps a private pool. A pthread build reads this name first.
        OPENBLAS_NUM_THREADS: "1",
        // MKL reads this name before OMP_NUM_THREADS.
        MKL_NUM_THREADS: "1",
        // data.table defaults to half of the visible cores.
        R_DATATABLE_NUM_THREADS: "1",
        // The Python numerical stack.
        NUMBA_NUM_THREADS: "1",
        NUMEXPR_MAX_THREADS: "1",
        POLARS_MAX_THREADS: "1",
        RAYON_NUM_THREADS: "1",
        // Worker counts: the quota.
        // BiocParallel sizes `bpparam()` from this name. DESeq2 `parallel=TRUE`
        // and the other Bioconductor packages size their workers from `bpparam()`.
        // `parallelly::availableCores()` reads it too, and under gVisor, where no
        // cgroup is visible, it is the only bound that library sees.
        BIOCPARALLEL_WORKER_NUMBER: workers,
        // loky caps its worker default at this name.
        LOKY_MAX_CPU_COUNT: workers,
    };
}
