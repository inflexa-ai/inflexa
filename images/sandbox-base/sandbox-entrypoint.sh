#!/bin/sh
# sandbox-server entrypoint.
#
# The Docker backend sets SANDBOX_EGRESS_FIREWALL=1 and starts the container as
# root with CAP_NET_ADMIN. Here we install an egress-deny firewall BEFORE any
# workload runs, then drop to the workload uid with no capabilities — so the
# sandboxed process can neither open a new outbound connection nor alter the
# rules. The reply path to the host's inbound poll is ESTABLISHED, so polling
# still works; loopback survives for local tooling. The server's endpoints
# carry no credential: because each sandbox denies its own egress, a sibling
# sandbox on the same bridge cannot reach this server's port either.
#
# The workload user comes from the env of the harness, the executor fact:
#
# - SANDBOX_UID, SANDBOX_GID, SANDBOX_GROUPS: a rootful engine on Linux. The
#   workload is the host user, with its supplementary groups, thus it has the
#   same access to each bind mount as the user. The `sandbox` entries of
#   /etc/passwd and /etc/group get the same ids, thus a passwd lookup and $HOME
#   follow the drop. A uid of 0 stays 1000: the server refuses root here.
# - SANDBOX_KEEP_GROUPS=1: rootless Podman with keep-id. The engine maps the
#   host user onto 1000 and gives the process the groups of the user. The drop
#   keeps those groups.
# - Neither: uid 1000, with the groups of the image.
#
# Default path (K8s, or any container that starts as the unprivileged workload
# user): exec sandbox-server directly. A K8s NetworkPolicy confines the pod.
set -e

# A malformed id must stop the start: a drop to a wrong user is a silent
# failure of each later command.
require_ids() {
    case "$2" in
        "" | *[!0-9$3]*)
            echo "sandbox-entrypoint: $1 holds a malformed value: $2" >&2
            exit 1
            ;;
    esac
}

# The seed of the prepared caches runs before the firewall path and before the
# exec. It lives in a file of its own, because the cache check of the build
# runs that same code while this script execs the server. Refer to
# /usr/local/lib/inflexa-seed-caches.sh.
. /usr/local/lib/inflexa-seed-caches.sh
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

    # The seed ran as root in this mode. Open the copies to the workload user:
    # numba writes new entries at run time, and a root-owned seed would be
    # read-only to the workload — the very failure the seed exists to prevent.
    # A chmod, not a chown: root holds no CAP_CHOWN here, but it owns the
    # copies. The copies are in the container, thus no host file changes.
    for _d in /tmp/numba-cache /tmp/matplotlib_config; do
        if [ -d "$_d" ]; then chmod -R a+rwX "$_d"; fi
    done

    _uid=1000
    _gid=1000
    _groups=--init-groups
    if [ "${SANDBOX_KEEP_GROUPS:-0}" = "1" ]; then
        _groups=--keep-groups
    elif [ -n "${SANDBOX_UID:-}" ]; then
        require_ids SANDBOX_UID "$SANDBOX_UID" ""
        require_ids SANDBOX_GID "${SANDBOX_GID:-}" ""
        if [ -n "${SANDBOX_GROUPS:-}" ]; then require_ids SANDBOX_GROUPS "$SANDBOX_GROUPS" ","; fi
        if [ "$SANDBOX_UID" != "0" ]; then
            _uid=$SANDBOX_UID
            _gid=$SANDBOX_GID
            # Root owns /etc/passwd and /etc/group, thus the edit needs no
            # capability. A gid that a group of the image has already keeps
            # that group, and the `sandbox` group keeps 1000.
            sed -i "s/^sandbox:x:1000:1000:/sandbox:x:$_uid:$_gid:/" /etc/passwd
            if ! cut -d: -f3 /etc/group | grep -qx "$_gid"; then
                sed -i "s/^sandbox:x:1000:/sandbox:x:$_gid:/" /etc/group
            fi
            # `--init-groups` reads the groups from /etc/group, which does not
            # know the groups of the host user. The list from the env does.
            if [ -n "${SANDBOX_GROUPS:-}" ]; then _groups=--groups=$SANDBOX_GROUPS; else _groups=--clear-groups; fi
        fi
    fi

    # Drop to the workload user with an empty capability bounding+inheritable
    # set, so the workload cannot regain CAP_NET_ADMIN and flush the rules above.
    exec setpriv --reuid="$_uid" --regid="$_gid" "$_groups" \
        --inh-caps=-all --bounding-set=-all \
        sandbox-server "$@"
fi

exec sandbox-server "$@"
