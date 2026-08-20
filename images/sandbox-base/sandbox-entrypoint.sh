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

# The seed of the prepared caches runs before the firewall path and before the
# exec. It lives in a file of its own, because the cache check of the build
# runs that same code while this script execs the server. Refer to
# /usr/local/bin/inflexa-seed-caches.
. /usr/local/bin/inflexa-seed-caches
seed_caches

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

    # The seed ran as root in this mode. Hand the copies to the workload uid:
    # numba writes new entries at run time, and a root-owned seed would be
    # read-only to uid 1000 — the very failure the seed exists to prevent.
    for _d in /tmp/numba-cache /tmp/matplotlib_config; do
        [ -d "$_d" ] && chown -R 1000:1000 "$_d" 2>/dev/null || true
    done

    # Drop to uid/gid 1000 with an empty capability bounding+inheritable set, so
    # the workload cannot regain CAP_NET_ADMIN and flush the rules above.
    exec setpriv --reuid=1000 --regid=1000 --init-groups \
        --inh-caps=-all --bounding-set=-all \
        sandbox-server "$@"
fi

exec sandbox-server "$@"
