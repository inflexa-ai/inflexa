#!/bin/sh
# sandbox-server entrypoint.
#
# Default path (callback mode, K8s, or any container that starts as the
# unprivileged workload user): exec sandbox-server directly. Confinement, where
# required, is provided outside the container (K8s NetworkPolicy).
#
# Docker poll mode sets SANDBOX_EGRESS_FIREWALL=1 and starts the container as
# root with CAP_NET_ADMIN. Here we install an egress-deny firewall BEFORE any
# workload runs, then drop to the workload uid with no capabilities — so the
# sandboxed process can neither open a new outbound connection nor alter the
# rules. The reply path to the host's inbound poll is ESTABLISHED, so polling
# still works; loopback survives for local tooling.
set -e

# Seed the store's prepared caches into writable paths before the workload starts.
# numba and matplotlib each pick a cache directory by writing a probe to it, so the
# store's read-only copy is skipped for reads as well as writes; copying it
# somewhere writable is what makes the provisioner's warm-up take effect at run time
# (measured: read-only cache -> 0 loads; seeded writable -> ~29 loads). Conditional
# on a store farm carrying the caches, so the baked-image path -- which has none
# under /mnt/libs/current -- is left exactly as it was. `return 0` is load-bearing:
# without it a failed `[ -d ]` in the no-store case would be the function's exit and
# `set -e` would abort the entrypoint, breaking every sandbox that mounts no store.
seed_caches() {
    _cur=/mnt/libs/current
    if [ -d "$_cur/numba-cache" ]; then
        mkdir -p /tmp/numba-cache && cp -a "$_cur/numba-cache/." /tmp/numba-cache/ 2>/dev/null || true
        export NUMBA_CACHE_DIR=/tmp/numba-cache
        # numba keys each cache entry by the target CPU. The provisioner built these
        # with a generic arm64 CPU (autodetect crashes LLVM codegen on newer cores),
        # so the sandbox must name the same CPU here or every entry misses.
        case "$(uname -m)" in
            aarch64 | arm64) export NUMBA_CPU_NAME=generic ;;
        esac
    fi
    if [ -d "$_cur/matplotlib_config" ]; then
        mkdir -p /tmp/matplotlib_config && cp -a "$_cur/matplotlib_config/." /tmp/matplotlib_config/ 2>/dev/null || true
        export MPLCONFIGDIR=/tmp/matplotlib_config
    fi
    return 0
}

if [ "${SANDBOX_EGRESS_FIREWALL:-0}" = "1" ]; then
    iptables -A OUTPUT -o lo -j ACCEPT
    iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    iptables -P OUTPUT DROP

    # iptables governs IPv4 only. If the container has an IPv6 stack (a
    # dual-stack bridge), the same egress-deny must be mirrored there or v6 is
    # a hole through the firewall. `set -e` keeps this fail-closed: an IPv6
    # stack whose rules cannot be installed aborts the start.
    if [ -f /proc/net/if_inet6 ]; then
        ip6tables -A OUTPUT -o lo -j ACCEPT
        ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
        ip6tables -P OUTPUT DROP
    fi

    # Seed as root, then hand the copies to the workload uid: numba writes new
    # entries at run time, and a root-owned seed would be read-only to uid 1000 --
    # the very failure this seeding exists to avoid.
    seed_caches
    for _d in /tmp/numba-cache /tmp/matplotlib_config; do
        [ -d "$_d" ] && chown -R 1000:1000 "$_d" 2>/dev/null || true
    done

    # Drop to uid/gid 1000 with an empty capability bounding+inheritable set, so
    # the workload cannot regain CAP_NET_ADMIN and flush the rules above.
    exec setpriv --reuid=1000 --regid=1000 --init-groups \
        --inh-caps=-all --bounding-set=-all \
        sandbox-server "$@"
fi

# Default path: the workload runs as the current (already unprivileged) user, so
# the seed is written with the ownership it needs and no chown is required.
seed_caches
exec sandbox-server "$@"
