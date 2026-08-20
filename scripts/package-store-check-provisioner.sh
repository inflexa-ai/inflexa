#!/usr/bin/env bash
# Container-level checks for the provisioner and the content-addressed store.
#
# The unit tests cannot cover the parts that only a real run shows: an
# advisory lock across two processes, a symlink that a mount resolves, a tree
# that root writes, and an exit code that a host reads. This suite drives the
# provisioner exactly as a host drives it, against a throwaway store root.
#
# The four checks, from the package-store-provisioner spec:
#   1. batch acquire — one bad spec drops out with its own refusal, and the
#      rest of the set still lands, with one outcome per spec.
#   2. two-phase commit — an acquire run stages its graph nodes in the report
#      and never touches deps.json.
#   3. both-hit refusal — an unqualified name that both ecosystems satisfy
#      stops with the two candidates, and nothing installs.
#   4. reclaim — an unreferenced store directory leaves, and a referenced one
#      stays.
#
# The acquire checks use a network, because the provisioner resolves against
# the index. The R side of the both-hit probe needs pak metadata, thus that
# check is the slowest.
#
# Usage: scripts/package-store-check-provisioner.sh [--keep]
#   --keep   do not remove the throwaway store root at the end
# Env:
#   PROVISIONER_IMAGE   the image to drive (default sandbox-provisioner:local)
#   CTR                 docker or podman (default: whichever has a daemon)

set -uo pipefail

PROVISIONER_IMAGE="${PROVISIONER_IMAGE:-sandbox-provisioner:local}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

CTR="${CTR:-}"
if [[ -z "$CTR" ]]; then
    if docker info >/dev/null 2>&1; then CTR=docker
    elif podman info >/dev/null 2>&1; then CTR=podman
    else echo "error: neither docker nor podman has a running daemon" >&2; exit 1
    fi
fi

"$CTR" image inspect "$PROVISIONER_IMAGE" >/dev/null 2>&1 || {
    echo "error: no image $PROVISIONER_IMAGE" >&2
    echo "  build it first: scripts/sandbox-images-build-local.sh" >&2
    exit 1
}

# A throwaway root, never the store of a user. The checks remove store
# directories, thus they must not touch a store that a sandbox reads.
STORE_ROOT="$(mktemp -d)"
mkdir -p "$STORE_ROOT/store" "$STORE_ROOT/farms"

PASS=0
FAIL=0
check() { # check <name> <ok:0|1>
    if [[ "$2" -eq 0 ]]; then
        PASS=$((PASS + 1)); echo "PASS: $1"
    else
        FAIL=$((FAIL + 1)); echo "FAIL: $1"
    fi
}

provision() { # provision [docker-args --] <subcommand args...>
    "$CTR" run --rm -v "$STORE_ROOT:/mnt/libs:rw" "$PROVISIONER_IMAGE" "$@"
}

json() { # json <file> <python-expression over `d`>
    # The eval reads a fixed expression that THIS script wrote, over a local
    # report file of the check run. No untrusted input reaches it — the rig is
    # a developer tool, not a service.
    python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "$1" "$2" 2>/dev/null
}

echo "=== package-store provisioner checks ($CTR, $PROVISIONER_IMAGE) ==="
echo "store root: $STORE_ROOT"

# --- 1 + 2: batch acquire, one refusal in the batch, deps.json untouched ----
# Two pure-Python distributions with no dependency of their own keep the run
# short, and one name that no index holds is the refusal of the batch.
REPORT=/mnt/libs/.acquire-check.json
provision acquire --report "$REPORT" \
    python:packaging python:six "python:no-such-distribution-inflexa-check"
rc=$?
check "acquire exits zero when part of the batch lands" "$rc"

HREPORT="$STORE_ROOT/.acquire-check.json"
outcomes=$(json "$HREPORT" "len(d['outcomes'])")
check "one outcome per spec (3)" "$([[ "$outcomes" == "3" ]]; echo $?)"
acquired=$(json "$HREPORT" "sum(1 for o in d['outcomes'] if o['outcome']=='acquired')")
check "the two good specs acquired" "$([[ "$acquired" == "2" ]]; echo $?)"
refused=$(json "$HREPORT" "sum(1 for o in d['outcomes'] if o['outcome']=='refused')")
check "the bad spec dropped out with its own refusal" "$([[ "$refused" == "1" ]]; echo $?)"
nodes=$(json "$HREPORT" "len(d['nodes'])")
check "the staged graph nodes ride in the report" "$([[ "$nodes" -ge 2 ]]; echo $?)"
check "deps.json stays untouched (the host commits)" "$([[ ! -e "$STORE_ROOT/deps.json" ]]; echo $?)"
check "the pool holds the acquired store directories" \
    "$([[ -n "$(ls -d "$STORE_ROOT"/store/packaging-* 2>/dev/null)" ]]; echo $?)"

# --- 3: the both-hit refusal ------------------------------------------------
# `igraph` exists on PyPI and on CRAN. An unqualified request must stop with
# the two candidates, and nothing must install.
provision acquire --report /mnt/libs/.bothhit-check.json igraph
rc=$?
check "a both-hit run still exits zero (the outcome carries the stop)" "$rc"
BREPORT="$STORE_ROOT/.bothhit-check.json"
bothhit=$(json "$BREPORT" "d['outcomes'][0]['outcome']")
check "the outcome is both_hit" "$([[ "$bothhit" == "both_hit" ]]; echo $?)"
candidates=$(json "$BREPORT" "len(d['outcomes'][0]['candidates'])")
check "the two candidates ride in the outcome" "$([[ "$candidates" == "2" ]]; echo $?)"
check "nothing installed for the both-hit name" \
    "$([[ -z "$(ls -d "$STORE_ROOT"/store/igraph-* 2>/dev/null)" ]]; echo $?)"

# --- 4: reclaim --------------------------------------------------------------
# A farm that links one directory protects it; the unreferenced one leaves.
REFERENCED=$(ls -d "$STORE_ROOT"/store/packaging-* | head -1)
UNREFERENCED=$(ls -d "$STORE_ROOT"/store/six-* | head -1)
FARM="$STORE_ROOT/farms/check"
mkdir -p "$FARM/python/site-packages"
ln -s "/mnt/libs/store/$(basename "$REFERENCED")/packaging" "$FARM/python/site-packages/packaging"
provision reclaim
rc=$?
check "reclaim exits zero" "$rc"
check "the referenced directory survives reclamation" "$([[ -d "$REFERENCED" ]]; echo $?)"
check "the unreferenced directory leaves" "$([[ ! -d "$UNREFERENCED" ]]; echo $?)"

# remove-farm removes the farm and never the pool.
provision remove-farm check
rc=$?
check "remove-farm exits zero" "$rc"
check "the farm leaves" "$([[ ! -d "$FARM" ]]; echo $?)"
check "the pool stays after remove-farm" "$([[ -d "$REFERENCED" ]]; echo $?)"

echo
echo "=== $PASS passed, $FAIL failed ==="
if [[ "$KEEP" -eq 0 ]]; then
    rm -rf "$STORE_ROOT"
else
    echo "kept: $STORE_ROOT"
fi
[[ "$FAIL" -eq 0 ]]
