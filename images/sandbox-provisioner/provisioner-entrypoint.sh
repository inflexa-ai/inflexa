#!/bin/sh
# Provisioner entrypoint — the egress allowlist, then the program.
#
# The provisioner is the one container with network access, and its egress is
# an allowlist, never open. The invoker names the permitted hosts in
# INFLEXA_EGRESS_ALLOW (comma-separated), and the class set depends on the
# mode: an acquisition run gets the pinned Python index and the pak
# repositories only; a catalog build adds the GitHub hosts and
# git.bioconductor.org for the catalog-only tracks.
#
# The rules install BEFORE the program runs: loopback, established return
# traffic, DNS, and the resolved addresses of each named host. Everything
# else drops. The list resolves once at start — a rotated CDN address after
# that point drops, and the run then fails loudly rather than reaching an
# unlisted host.
#
# An unset INFLEXA_EGRESS_ALLOW execs the program directly. The workflow and
# the host set the variable; a bare local run stays usable.
set -e

if [ -n "${INFLEXA_EGRESS_ALLOW:-}" ]; then
    iptables -A OUTPUT -o lo -j ACCEPT
    iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    # Name resolution stays open: the allowlist is of names, and each HTTPS
    # connection below still has to match a resolved address.
    iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
    iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

    OLD_IFS=$IFS
    IFS=','
    for host in $INFLEXA_EGRESS_ALLOW; do
        host=$(echo "$host" | tr -d ' ')
        [ -n "$host" ] || continue
        for ip in $(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u); do
            iptables -A OUTPUT -d "$ip" -p tcp --dport 443 -j ACCEPT
            iptables -A OUTPUT -d "$ip" -p tcp --dport 80 -j ACCEPT
        done
    done
    IFS=$OLD_IFS

    iptables -P OUTPUT DROP
    if [ -f /proc/net/if_inet6 ]; then
        # The v4 rules alone would leave a hole through a dual-stack bridge.
        # The v6 policy is a plain drop, because getent above resolved v4 only.
        ip6tables -A OUTPUT -o lo -j ACCEPT
        ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
        ip6tables -P OUTPUT DROP
    fi
    echo "[provisioner-entrypoint] egress allowlist active: ${INFLEXA_EGRESS_ALLOW}"
fi

exec /usr/local/bin/provision "$@"
