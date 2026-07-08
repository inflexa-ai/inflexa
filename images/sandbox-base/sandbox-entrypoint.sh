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

if [ "${SANDBOX_EGRESS_FIREWALL:-0}" = "1" ]; then
    iptables -A OUTPUT -o lo -j ACCEPT
    iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    iptables -P OUTPUT DROP

    # Drop to uid/gid 1000 with an empty capability bounding+inheritable set, so
    # the workload cannot regain CAP_NET_ADMIN and flush the rules above.
    exec setpriv --reuid=1000 --regid=1000 --init-groups \
        --inh-caps=-all --bounding-set=-all \
        sandbox-server "$@"
fi

exec sandbox-server "$@"
