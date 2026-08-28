/**
 * The two cpu files that a sandbox reads for its core count.
 *
 * The thread env (`thread-env.ts`) reaches each library that reads a thread
 * count from the environment. Two base calls read a kernel file instead:
 * `parallel::detectCores()` greps `/proc/cpuinfo`, and `os.cpu_count()` of
 * Python 3.12 reads `/sys/devices/system/cpu/online` through glibc. Both files
 * describe the host, not the cgroup. A read-only bind of a small file over each
 * path makes both calls report the quota.
 *
 * This module makes the content of the two files, and it reads the
 * `/proc/cpuinfo` of the harness host that the content is cut from. The Docker
 * backend writes the content to the host and binds it. The K8s backend puts
 * the content in a ConfigMap and mounts each key with `subPath`.
 */

import { readFile } from "node:fs/promises";

/** The two container paths that the cpu files cover. */
export const CPU_ONLINE_PATH = "/sys/devices/system/cpu/online";
export const CPUINFO_PATH = "/proc/cpuinfo";

/**
 * The `/proc/cpuinfo` of the harness host, read once per process. The content
 * does not change while the process runs. A host with no such file, for
 * example macOS, gives `undefined`, and the caller covers only `online`.
 */
let hostCpuinfo: Promise<string | undefined> | undefined;
export function readHostCpuinfoOnce(): Promise<string | undefined> {
    hostCpuinfo ??= readFile(CPUINFO_PATH, "utf8").catch(() => undefined);
    return hostCpuinfo;
}

export interface CpuFiles {
    /** Content of `/sys/devices/system/cpu/online`: `0` for one thread, else the range `0-<n-1>`. */
    readonly online: string;
    /**
     * Content of `/proc/cpuinfo`: the first n `processor` blocks of the real file
     * of the host. `undefined` when the host gives no `/proc/cpuinfo`.
     */
    readonly cpuinfo: string | undefined;
}

/**
 * Split the text of `/proc/cpuinfo` into its `processor` blocks. A blank line
 * ends a block. A block with no `processor` line, for example the `Hardware`
 * trailer of an ARM kernel, is not a processor and is dropped.
 */
function processorBlocks(cpuinfo: string): string[] {
    return cpuinfo
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .filter((block) => /^processor\b/m.test(block));
}

/**
 * The content of the two cpu files for `threads` cpus.
 *
 * `threads` is a positive integer. The caller applies the same floor as
 * `threadLimitEnv`: `Math.max(1, Math.floor(spec.cpu))`. When the host has fewer
 * processor blocks than `threads`, all blocks stay. Each block keeps its own
 * text, thus the `processor` numbers stay `0` to `n-1` as in the real file.
 */
export function cpuFiles(threads: number, hostCpuinfo: string | undefined): CpuFiles {
    const online = `${threads === 1 ? "0" : `0-${threads - 1}`}\n`;
    if (hostCpuinfo === undefined) return { online, cpuinfo: undefined };
    const blocks = processorBlocks(hostCpuinfo).slice(0, threads);
    return { online, cpuinfo: blocks.map((block) => `${block}\n\n`).join("") };
}
