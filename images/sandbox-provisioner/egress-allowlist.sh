#!/bin/sh
# The egress allowlist of the provisioner. The entrypoint sources this file
# and calls apply_egress_allowlist; the CI canary sources the same file, thus
# the wall that the canary proves is the wall that the build runs behind.
#
# WHY a live-DNS design: the first live catalog build resolved each host one
# time, pinned the addresses into /etc/hosts, and froze them for the whole
# run. p3m.dev publishes a 60-second TTL over a rotating load-balancer pool,
# and a rotated-out address drops new connections in silence. Every CRAN
# download then hung to its five-minute timeout, and the job died at its
# budget with zero packages. Thus the allowlist follows DNS instead of
# freezing it: dnsmasq inserts the addresses of each answer into a firewall
# set before it forwards the answer, and the rules accept only the addresses
# of that set. The rules and each later connect agree at every moment of a
# long build, through every rotation.
#
# WHY nftables and not ipset: the ip_set kernel module is not loadable from
# a container, and a builder without it would fail. The nf_tables backend is
# already proven on every host here, because the iptables binary of this
# image runs on it.
#
# The invoker names the permitted hosts in INFLEXA_EGRESS_ALLOW
# (comma-separated). An unset variable applies nothing.
apply_egress_allowlist() {
    [ -n "${INFLEXA_EGRESS_ALLOW:-}" ] || return 0

    # The upstream resolvers, read before this function rewrites resolv.conf.
    upstreams=$(awk '/^nameserver/ { print $2 }' /etc/resolv.conf)
    if [ -z "$upstreams" ]; then
        echo "[egress-allowlist] no upstream resolver in /etc/resolv.conf" >&2
        return 1
    fi

    # The policy of the chain is drop, and the last rule is reject. REJECT
    # makes a refused connect fail in milliseconds and name itself in the
    # client error. The first live run showed the cost of a silent drop —
    # each blocked download burned its full timeout before the failure
    # surfaced in the log.
    nft add table ip inflexa-egress
    nft add set ip inflexa-egress allow4 '{ type ipv4_addr; }'
    nft add chain ip inflexa-egress output '{ type filter hook output priority 0 ; policy drop ; }'
    nft add rule ip inflexa-egress output oifname "lo" accept
    nft add rule ip inflexa-egress output ct state established,related accept
    # DNS reaches the original upstreams only. Every process resolves
    # through dnsmasq on loopback, and dnsmasq forwards to these addresses.
    for ns in $upstreams; do
        nft add rule ip inflexa-egress output ip daddr "$ns" udp dport 53 accept
        nft add rule ip inflexa-egress output ip daddr "$ns" tcp dport 53 accept
    done
    nft add rule ip inflexa-egress output ip daddr @allow4 tcp dport '{ 80, 443 }' accept
    nft add rule ip inflexa-egress output reject
    if [ -f /proc/net/if_inet6 ]; then
        # dnsmasq filters AAAA answers below, thus no allowlisted name
        # resolves to v6. The reject stops a literal v6 address.
        nft add table ip6 inflexa-egress6
        nft add chain ip6 inflexa-egress6 output '{ type filter hook output priority 0 ; policy drop ; }'
        nft add rule ip6 inflexa-egress6 output oifname "lo" accept
        nft add rule ip6 inflexa-egress6 output ct state established,related accept
        nft add rule ip6 inflexa-egress6 output reject
    fi

    # One --server per upstream. $servers expands unquoted with the default
    # IFS on purpose: it holds space-separated flags, never user text.
    servers=""
    for ns in $upstreams; do servers="$servers --server=$ns"; done
    # The nftset directive takes the domains slash-separated, and it feeds
    # the A records of each answer into the set before the answer returns,
    # thus no connect can race its own rule. A listed domain also covers its
    # subdomains, and a CNAME chain lands under the name the invoker listed.
    domains=$(printf '%s' "$INFLEXA_EGRESS_ALLOW" | tr ',' '/')
    dnsmasq --conf-file=/dev/null --no-resolv $servers \
        --listen-address=127.0.0.1 --bind-interfaces \
        --nftset="/${domains}/4#ip#inflexa-egress#allow4" \
        --filter-AAAA
    printf 'nameserver 127.0.0.1\n' > /etc/resolv.conf

    # Prime one resolution per host: it proves that dnsmasq answers, and it
    # reports a host that does not resolve while the log is short.
    resolved=0
    for host in $(printf '%s' "$INFLEXA_EGRESS_ALLOW" | tr ',' ' '); do
        [ -n "$host" ] || continue
        if getent hosts "$host" > /dev/null 2>&1; then
            resolved=$((resolved + 1))
        else
            echo "[egress-allowlist] WARNING: $host does not resolve" >&2
        fi
    done
    echo "[egress-allowlist] active: ${INFLEXA_EGRESS_ALLOW} (${resolved} host(s) resolve)"
}
