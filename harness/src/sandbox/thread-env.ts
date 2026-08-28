/**
 * Thread-count env for a sandbox container.
 *
 * The backends turn a step's `ResourceSpec` into a hard cgroup limit
 * (`NanoCpus`/`Memory` on Docker, `limits.cpu`/`limits.memory` on K8s). A cgroup
 * quota is invisible to the runtimes inside it: `parallel::detectCores()` and
 * the OpenBLAS thread pool read the host's core count from `/proc`, not the
 * quota. A step given 2 CPUs on a 12-core host therefore forks 12 workers into
 * a cgroup sized for 2, and each fork carries its own copy of the working set
 * until the memory limit is reached. sandbox-server shares that cgroup, so the
 * thrash takes the exec endpoint down with the workload.
 *
 * The fix is to publish the quota that the cgroup already enforces, so the
 * libraries size their pools from the same number.
 */

import type { ResourceSpec } from "../config/resource-limits.js";

/**
 * Env that binds every parallel runtime in the container to `spec.cpu`.
 *
 * A fractional CPU request floors to one thread, because a pool of zero is not
 * representable and a pool of two on half a core only adds context switches.
 *
 * The caller places these before `plan.env` and the embedder's `extraEnv`, so a
 * host that knows better about a particular step keeps the last word.
 */
export function threadLimitEnv(spec: ResourceSpec): Record<string, string> {
    const threads = String(Math.max(1, Math.floor(spec.cpu)));
    return {
        // OpenMP: the R and Python numerical stacks, and the compiled code of
        // most Bioconductor packages.
        OMP_NUM_THREADS: threads,
        // OpenBLAS keeps its own pool and ignores OMP_NUM_THREADS when it is
        // built with its own threading.
        OPENBLAS_NUM_THREADS: threads,
        // R reads this at startup into `options(mc.cores)`, which is what
        // `mclapply` and BiocParallel size their worker count from.
        MC_CORES: threads,
    };
}
