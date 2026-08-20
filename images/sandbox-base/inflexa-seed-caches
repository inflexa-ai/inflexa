#!/bin/sh
# The seed of the prepared caches. A caller sources this file.
#
# numba and matplotlib each select a cache directory by a write of a probe into
# it. Thus each one skips the read-only store, for a read as much as for a
# write, and a copy to a writable path is what makes the preparation of the
# provisioner take effect at run time. Measured: a read-only cache gives 0
# loads, and a seeded writable copy gives about 29.
#
# The file defines one function and it does nothing else. It runs no command,
# and it starts no workload. The entrypoint sources it before it execs the
# server, and the cache check of the build sources it before it runs its own
# program. As a result the check exercises the code that a sandbox runs.

seed_caches() {
    # The read-write cache mount of the analysis. When it is present, the env
    # of the mount plan already points into it, and the seed does nothing. The
    # probe is a real write, because a permission bit cannot see a read-only
    # mount, and root passes a permission bit regardless.
    if [ -d /mnt/libs/cache ] && touch /mnt/libs/cache/.inflexa-write-probe 2>/dev/null; then
        rm -f /mnt/libs/cache/.inflexa-write-probe 2>/dev/null || true
        return 0
    fi
    # No cache mount: copy the prepared caches of the farm to writable paths
    # under /tmp. A missing cache degrades in silence, because a cold cache
    # costs time and not correctness.
    _farm=/mnt/libs/farm
    if [ -d "$_farm/numba-cache" ]; then
        mkdir -p /tmp/numba-cache && cp -a "$_farm/numba-cache/." /tmp/numba-cache/ 2>/dev/null || true
        export NUMBA_CACHE_DIR=/tmp/numba-cache
        # numba keys each cache entry by the target CPU. The provisioner
        # prepared these with a generic arm64 CPU, because the autodetection
        # of the host CPU crashes the code generator of LLVM on a newer core.
        # Thus a sandbox must name the same CPU here, or each entry misses.
        case "$(uname -m)" in
            aarch64 | arm64) export NUMBA_CPU_NAME=generic ;;
        esac
    fi
    if [ -d "$_farm/matplotlib_config" ]; then
        mkdir -p /tmp/matplotlib_config && cp -a "$_farm/matplotlib_config/." /tmp/matplotlib_config/ 2>/dev/null || true
        export MPLCONFIGDIR=/tmp/matplotlib_config
    fi
    # `return 0` is load-bearing. Without it a failed `[ -d ]` in the case
    # with no store becomes the exit of the function, and `set -e` in a caller
    # then stops each sandbox that mounts no store.
    return 0
}
