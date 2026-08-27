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
# The mechanism lives in egress-allowlist.sh, one file for this entrypoint
# and for the CI canary. An unset INFLEXA_EGRESS_ALLOW execs the program
# directly; the workflow and the host set the variable, and a bare local run
# stays usable.
set -e

. /usr/local/bin/egress-allowlist.sh
apply_egress_allowlist

exec /usr/local/bin/provision "$@"
