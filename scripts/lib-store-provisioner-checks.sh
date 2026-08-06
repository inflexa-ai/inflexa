#!/usr/bin/env bash
# Container-level checks for the Provisioner and the content-addressed store.
#
# images/sandbox-provisioner/test_provision.py covers the store logic as unit
# tests, with no container. It cannot cover the parts that only a real run shows:
# an advisory lock across two processes, a symlink that a mount resolves, a tree
# that root writes and uid 1000 reads, and an exit code that a host reads.
#
# Each check names one way the design can be wrong. The suite drives the
# Provisioner exactly as a host drives it, against a throwaway store root.
#
# Scope: the Python track and the store operations. The R track is out of scope,
# because a pak build takes tens of minutes and a large amount of memory. The
# store-against-image compare is out of scope too, and belongs to the next phase.
#
# Two checks use a network, because the Provisioner resolves against the index.
# Every other check runs with the network off.
#
# Usage: scripts/lib-store-provisioner-checks.sh [--keep]
#   --keep   do not remove the throwaway store root at the end
# Env:
#   PROVISIONER_IMAGE   the image to drive (default inflexa-provisioner:local)
#   LIB_STORE           the throwaway store root (default a fresh mktemp -d)
#   CTR                 docker or podman (default: whichever has a daemon)

set -uo pipefail

PROVISIONER_IMAGE="${PROVISIONER_IMAGE:-inflexa-provisioner:local}"
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
    echo "  build it first: scripts/store-prototype/inflexa-store build" >&2
    exit 1
}

# A throwaway root, never the store of the user. The checks tamper with content
# and remove farms, so they must not touch a store that a sandbox reads.
STORE_ROOT="${LIB_STORE:-$(mktemp -d)}"
LOCK_HOLDER="provisioner-checks-lock-$$"

# Two pure-Python distributions with no dependency of their own. The suite proves
# the mechanism, thus a small closure keeps each run short.
PKG_A=packaging
PKG_B=six
# A third small distribution for the hard-case checks, kept distinct from PKG_A and
# PKG_B so it does not disturb the reuse and the reclaim counts above.
PKG_C=idna
# One larger distribution. A fresh install of it lasts long enough to interrupt, and
# long enough for a second run to meet a held store lock. It is one package, with no
# closure of its own here.
PKG_BIG=numpy
# The prefix provision.py gives a farm staging directory (see FARM_STAGING there).
FARM_STAGING=.staging-

PASSED=0
FAILED=0

ok()   { printf '  PASS  %s\n' "$1"; PASSED=$((PASSED + 1)); }
bad()  { printf '  FAIL  %s\n' "$1"; [[ -n "${2:-}" ]] && printf '        %s\n' "$2"; FAILED=$((FAILED + 1)); }
head2() { printf '\n=== %s ===\n' "$1"; }

# The store is mounted at /mnt/libs in each of these, because a farm links to
# absolute targets under that path. A different mount point breaks every link.
run_net() { "$CTR" run --rm -v "$STORE_ROOT:/mnt/libs:rw" "$PROVISIONER_IMAGE" "$@" 2>&1; }
run_off() { "$CTR" run --rm --network none -v "$STORE_ROOT:/mnt/libs:rw" "$PROVISIONER_IMAGE" "$@" 2>&1; }
run_ro()  { "$CTR" run --rm --network none -v "$STORE_ROOT:/mnt/libs:ro" "$PROVISIONER_IMAGE" "$@" 2>&1; }
# A shell in the store, for the steps that must write as the Provisioner wrote.
# A write from the host is not equal: on macOS a container that starts directly
# after a host write can read the old bytes.
in_store() { "$CTR" run --rm --network none -v "$STORE_ROOT:/mnt/libs:rw" \
             --entrypoint sh "$PROVISIONER_IMAGE" -c "$1" 2>&1; }

cleanup() {
    "$CTR" rm -f "$LOCK_HOLDER" crashrun race1 >/dev/null 2>&1
    if [[ $KEEP -eq 0 ]]; then
        # The store is written as root, thus a host `rm -rf` can fail. Remove the
        # content from a container, then remove the empty root.
        in_store 'rm -rf /mnt/libs/* /mnt/libs/.[!.]*' >/dev/null 2>&1
        rmdir "$STORE_ROOT" 2>/dev/null
    else
        echo "store kept at $STORE_ROOT"
    fi
}
trap cleanup EXIT

store_dirs() { ls -1 "$STORE_ROOT/store" 2>/dev/null | grep -v '^\.' ; }
count_store_dirs() { store_dirs | grep -c . ; }
current_target() { readlink "$STORE_ROOT/current" 2>/dev/null ; }

echo "engine:  $CTR"
echo "image:   $PROVISIONER_IMAGE"
echo "store:   $STORE_ROOT"

# ---------------------------------------------------------------------------
head2 "the store check on an empty root"
# A root with no store/ directory is a normal empty store, not an error. The
# harness makes this root before the first run.
out=$(run_ro --verify); rc=$?
if [[ $rc -eq 0 ]] && grep -q "no store" <<<"$out"; then
    ok "an empty store root reports no store, with exit 0"
else
    bad "an empty store root gave exit $rc" "$(tail -2 <<<"$out")"
fi

# ---------------------------------------------------------------------------
head2 "a resolve that fails"
# The Provisioner cannot reach the index with the network off. A host reads the
# exit code and the message, thus a raw traceback is a defect.
out=$(run_off --farm netfail "$PKG_A"); rc=$?
if [[ $rc -ne 0 ]]; then ok "a failed resolve exits non-zero ($rc)"
else bad "a failed resolve exited 0"; fi
if grep -q "Traceback" <<<"$out"; then bad "a failed resolve prints a traceback" "$(tail -3 <<<"$out")"
else ok "a failed resolve prints no traceback"; fi
if grep -qi "could not resolve\|index" <<<"$out"; then ok "the message names the index"
else bad "the message does not name the index" "$(tail -2 <<<"$out")"; fi

# ---------------------------------------------------------------------------
head2 "a spec that bypasses the pinned index"
# A direct URL, a local path, or an archive name reaches an artifact that the
# index never served, thus the hash of the index proves nothing about it.
out=$(run_off --farm offindex "https://example.invalid/thing-1.0-py3-none-any.whl"); rc=$?
if [[ $rc -ne 0 ]] && grep -q "bypass the pinned index" <<<"$out"; then
    ok "an off-index spec is refused before the resolve"
else
    bad "an off-index spec gave exit $rc" "$(tail -2 <<<"$out")"
fi

# ---------------------------------------------------------------------------
head2 "content addressing and the farm records"
out=$(run_net --farm alpha "$PKG_A"); rc=$?
if [[ $rc -ne 0 ]]; then
    bad "the first provision run failed" "$(tail -5 <<<"$out")"
    echo; echo "the remaining checks need a store; stopping"; exit 1
fi
ok "a provision run completes"

dir=$(store_dirs | head -1)
if [[ "$dir" =~ ^${PKG_A}-.+-[0-9a-f]{16}$ ]]; then
    ok "the store directory carries the name, the version, and a 16-character address ($dir)"
else
    bad "the store directory name is not content-addressed" "$dir"
fi

pin=$(cat "$STORE_ROOT/store/$dir/.inflexa-pin" 2>/dev/null)
if [[ "$pin" == "$PKG_A=="* ]]; then ok "the pin marker records the resolved pin ($pin)"
else bad "the pin marker is absent or wrong" "$pin"; fi

missing=""
for f in lock.json meta.json packages.txt; do
    [[ -f "$STORE_ROOT/farms/alpha/$f" ]] || missing="$missing $f"
done
if [[ -z "$missing" ]]; then ok "the farm holds lock.json, meta.json, and packages.txt"
else bad "the farm has no$missing" "libStoreUsable drops a farm that has no packages.txt and no meta.json"; fi

# ---------------------------------------------------------------------------
head2 "reuse across two farms"
before=$(count_store_dirs)
out=$(run_net --farm beta "$PKG_A"); rc=$?
after=$(count_store_dirs)
if [[ $rc -eq 0 ]] && [[ "$before" == "$after" ]]; then
    ok "a second farm reuses the stored copy (still $after directory)"
else
    bad "the second farm changed the store from $before to $after directories" "exit $rc"
fi

# ---------------------------------------------------------------------------
head2 "the per-store lock"
# A second run must report the conflict, and it must not queue behind a build of
# unknown length. The holder takes the same advisory lock that the Provisioner
# takes, thus this is the real contention and not a simulation.
"$CTR" run --rm -d --name "$LOCK_HOLDER" \
    -v "$STORE_ROOT:/mnt/libs:rw" \
    --entrypoint python3 "$PROVISIONER_IMAGE" -c '
import fcntl, os, time
fd = os.open("/mnt/libs/.provision.lock", os.O_CREAT | os.O_RDWR, 0o644)
fcntl.flock(fd, fcntl.LOCK_EX)
open("/mnt/libs/.lock-held", "w").write("1")
time.sleep(90)
' >/dev/null 2>&1

held=0
for _ in $(seq 1 30); do
    [[ -f "$STORE_ROOT/.lock-held" ]] && { held=1; break; }
    sleep 1
done
if [[ $held -eq 0 ]]; then
    bad "the lock holder never took the lock" "the contention check did not run"
else
    out=$(run_off --farm alpha "$PKG_A"); rc=$?
    if [[ $rc -ne 0 ]] && grep -q "store lock" <<<"$out"; then
        ok "a second run reports the conflict and exits non-zero ($rc)"
    else
        bad "a second run gave exit $rc" "$(tail -2 <<<"$out")"
    fi
fi
"$CTR" rm -f "$LOCK_HOLDER" >/dev/null 2>&1
in_store 'rm -f /mnt/libs/.lock-held' >/dev/null 2>&1

# ---------------------------------------------------------------------------
head2 "the mount lease"
# A live sandbox resolves /mnt/libs/current. To move that symlink breaks its view
# of the path, thus a re-point is an operation between sandboxes.
run_off --add-lease sbx-1 >/dev/null 2>&1
was=$(current_target)
out=$(run_net --farm alpha "$PKG_A"); rc=$?
now=$(current_target)
if [[ $rc -ne 0 ]] && grep -q "lease" <<<"$out"; then ok "the re-point is refused, with exit $rc"
else bad "the re-point gave exit $rc" "$(tail -2 <<<"$out")"; fi
if [[ "$was" == "$now" ]]; then ok "current did not move (still $now)"
else bad "current moved from $was to $now"; fi

# The refusal is a designed outcome, not a crash. Thus the farm must keep the
# records that a later run and libStoreUsable both read.
missing=""
for f in lock.json meta.json packages.txt; do
    [[ -f "$STORE_ROOT/farms/alpha/$f" ]] || missing="$missing $f"
done
if [[ -z "$missing" ]]; then ok "the refused re-point left the records of the farm intact"
else bad "the refused re-point destroyed$missing" "a later run then answers nothing to do"; fi

out=$(run_net --farm alpha --force-repoint "$PKG_A"); rc=$?
if [[ $rc -eq 0 ]] && [[ "$(current_target)" == "farms/alpha" ]]; then
    ok "--force-repoint moves current for a stale lease"
else
    bad "--force-repoint gave exit $rc and current is $(current_target)" "$(tail -2 <<<"$out")"
fi
run_off --drop-lease sbx-1 >/dev/null 2>&1

# ---------------------------------------------------------------------------
head2 "repair of an abandoned .staging tree"
# A run that dies before its rename leaves debris in store/.staging. Nothing
# there is ever a published package, because a publish is a rename out of it.
in_store 'mkdir -p /mnt/libs/store/.staging/junk && echo x > /mnt/libs/store/.staging/junk/f' >/dev/null 2>&1
out=$(run_off --repair); rc=$?
if [[ $rc -eq 0 ]] && [[ ! -d "$STORE_ROOT/store/.staging" ]]; then
    ok "--repair clears the abandoned .staging tree"
else
    bad "--repair gave exit $rc and .staging still exists" "$(tail -2 <<<"$out")"
fi

# ---------------------------------------------------------------------------
head2 "removal of a farm"
out=$(run_off --remove-farm alpha); rc=$?
if [[ $rc -ne 0 ]] && grep -q "current points at it" <<<"$out"; then
    ok "the farm that current selects cannot be removed"
else
    bad "the live farm gave exit $rc" "$(tail -2 <<<"$out")"
fi
out=$(run_off --remove-farm beta); rc=$?
if [[ $rc -eq 0 ]] && [[ ! -d "$STORE_ROOT/farms/beta" ]]; then ok "another farm is removed"
else bad "the removal of beta gave exit $rc" "$(tail -2 <<<"$out")"; fi

# ---------------------------------------------------------------------------
head2 "reclamation"
# A package that no farm references stays until a host asks for it to go. The
# store keeps it, thus an old analysis can be built again.
out=$(run_net --farm gamma "$PKG_B"); rc=$?
if [[ $rc -ne 0 ]]; then
    bad "the provision run for $PKG_B failed" "$(tail -5 <<<"$out")"
else
    run_off --remove-farm alpha >/dev/null 2>&1
    out=$(run_off --reclaim); rc=$?
    left=$(store_dirs)
    if [[ $rc -eq 0 ]] && grep -q "^${PKG_B}-" <<<"$left" && ! grep -q "^${PKG_A}-" <<<"$left"; then
        ok "reclaim removed the unreferenced package and kept the referenced one"
    else
        bad "reclaim gave exit $rc and left: $(tr '\n' ' ' <<<"$left")" "$(tail -2 <<<"$out")"
    fi
fi

# ---------------------------------------------------------------------------
head2 "the store check on tampered content"
# The store is write-once, thus content that no longer matches its address is
# corruption or tampering, and never a legitimate change.
target=$(store_dirs | head -1)
if [[ -z "$target" ]]; then
    bad "no store directory left to tamper with" "the reclaim check removed too much"
else
    in_store "find /mnt/libs/store/$target -type f -name '*.py' | head -1 | xargs -r sh -c 'echo \"# tamper\" >> \$0'" >/dev/null 2>&1
    out=$(run_ro --verify); rc=$?
    if [[ $rc -eq 1 ]] && grep -q "MISMATCH" <<<"$out"; then
        ok "the store check names the tampered directory, with exit 1"
    else
        bad "the store check gave exit $rc" "$(tail -3 <<<"$out")"
    fi
fi

# ---------------------------------------------------------------------------
head2 "an interrupted provisioning run"
# A hard kill must never leave a reachable farm with links and no records. The farm
# is assembled in an unreachable staging directory and swapped in atomically, thus
# the live farm the harness reads stays complete through the interrupt, and the next
# run repairs the debris. This is the container form of the defect-1 fix.
out=$(run_net --farm crashfarm "$PKG_C"); rc=$?
if [[ $rc -ne 0 ]]; then
    bad "could not create the farm to interrupt" "$(tail -3 <<<"$out")"
else
    ok "a farm to interrupt is in place"
    was=$(current_target)

    # A re-provision that adds a fresh, larger package lasts long enough to interrupt.
    # SIGKILL is the same stop as a lost container or an out-of-memory kill.
    "$CTR" rm -f crashrun >/dev/null 2>&1
    "$CTR" run -d --name crashrun -v "$STORE_ROOT:/mnt/libs:rw" \
        "$PROVISIONER_IMAGE" --farm crashfarm "$PKG_BIG" >/dev/null 2>&1
    sleep 1
    "$CTR" kill -s KILL crashrun >/dev/null 2>&1
    "$CTR" rm -f crashrun >/dev/null 2>&1

    # The live farm kept every record and its original content, and current did not move.
    missing=""
    for f in lock.json meta.json packages.txt; do
        [[ -f "$STORE_ROOT/farms/crashfarm/$f" ]] || missing="$missing $f"
    done
    present=$(in_store "[ -e /mnt/libs/farms/crashfarm/python/site-packages/$PKG_C ] && echo yes")
    if [[ -z "$missing" ]] && [[ "$present" == "yes" ]] && [[ "$(current_target)" == "$was" ]]; then
        ok "the interrupt left the live farm complete, with its records and its content"
    else
        bad "the interrupt damaged the live farm" \
            "missing:$missing content:${present:-none} current:$(current_target)"
    fi

    # A half-built farm placed at the staging path is unreachable: current never
    # selects it, and repair removes it without touching the live farm.
    in_store "mkdir -p /mnt/libs/farms/${FARM_STAGING}crashfarm/python/site-packages && \
              ln -s /mnt/libs/store/none /mnt/libs/farms/${FARM_STAGING}crashfarm/python/site-packages/x" >/dev/null 2>&1
    run_off --repair >/dev/null 2>&1
    if [[ -z "$(in_store "ls -d /mnt/libs/farms/${FARM_STAGING}crashfarm 2>/dev/null")" ]] \
       && [[ -f "$STORE_ROOT/farms/crashfarm/lock.json" ]]; then
        ok "repair clears the unreachable half-built farm and keeps the live one"
    else
        bad "repair did not clear the half-built staging farm or damaged the live farm"
    fi

    # The requested set survived, thus the re-run adds to it rather than reporting
    # nothing to do, and the farm ends complete with both packages.
    out=$(run_net --farm crashfarm "$PKG_BIG"); rc=$?
    both=$(in_store "for p in $PKG_C $PKG_BIG; do [ -e /mnt/libs/farms/crashfarm/python/site-packages/\$p ] || echo no; done")
    if [[ $rc -eq 0 ]] && [[ -z "$both" ]]; then
        ok "repair and a re-run recover the farm with the full requested set"
    else
        bad "the re-run gave exit $rc and the farm is incomplete" "$(tail -2 <<<"$out")"
    fi
fi

# ---------------------------------------------------------------------------
head2 "a full disk"
# The store lives on a small tmpfs that a filler fills to the brim, so the next
# install has nowhere to write. The run must fail with a clear message and a
# non-zero exit, never a raw traceback. The tmpfs is private to this container, thus
# the check never touches the shared store.
out=$("$CTR" run --rm --tmpfs /mnt/libs:size=6m,mode=1777 \
      --entrypoint sh "$PROVISIONER_IMAGE" -c \
      "dd if=/dev/zero of=/mnt/libs/.fill bs=1M 2>/dev/null; exec python3 /usr/local/bin/provision --farm diskfull $PKG_C" 2>&1); rc=$?
if [[ $rc -ne 0 ]]; then ok "a full disk fails the run, with exit $rc"
else bad "a full disk did not fail the run"; fi
if grep -q "Traceback" <<<"$out"; then bad "a full disk prints a traceback" "$(tail -3 <<<"$out")"
else ok "a full disk prints no traceback"; fi
if grep -qi "no space left on device" <<<"$out"; then ok "the message names the full disk"
else bad "the message does not name the full disk" "$(tail -2 <<<"$out")"; fi

# ---------------------------------------------------------------------------
head2 "two provisioners at once"
# Two real provisioning runs contend for one store. The per-store lock is
# non-blocking, thus exactly one runs and the other reports the conflict at once
# rather than queueing behind a build of unknown length. A private store root keeps
# the timing deterministic: the larger package is a fresh install for the first run,
# so it still holds the lock when the second run starts.
race_root=$(mktemp -d)
race_log=$(mktemp)
"$CTR" run --rm --name race1 -v "$race_root:/mnt/libs:rw" \
    "$PROVISIONER_IMAGE" --farm race1 "$PKG_BIG" >"$race_log" 2>&1 &
race_bg=$!
sleep 1.5
out2=$("$CTR" run --rm -v "$race_root:/mnt/libs:rw" "$PROVISIONER_IMAGE" --farm race2 "$PKG_B" 2>&1); rc2=$?
wait "$race_bg"; rc1=$?
if [[ $rc1 -eq 0 && $rc2 -ne 0 ]] && grep -q "store lock" <<<"$out2"; then
    ok "one run completes and the other reports the store lock (exit $rc1 / $rc2)"
elif [[ $rc1 -ne 0 && $rc2 -eq 0 ]] && grep -q "store lock" "$race_log"; then
    ok "one run completes and the other reports the store lock (exit $rc1 / $rc2)"
else
    bad "the two runs did not serialize (exit $rc1 / $rc2)" \
        "$(tail -1 "$race_log"; tail -1 <<<"$out2")"
fi
# The winning run left a complete farm: the concurrent refusal did not corrupt the store.
winner=race1; [[ $rc1 -eq 0 ]] || winner=race2
wmissing=""
for f in lock.json meta.json packages.txt; do
    [[ -f "$race_root/farms/$winner/$f" ]] || wmissing="$wmissing $f"
done
if [[ -z "$wmissing" ]]; then ok "the winning run left a complete farm"
else bad "the winning farm is missing$wmissing"; fi
"$CTR" run --rm --network none -v "$race_root:/mnt/libs:rw" --entrypoint sh \
    "$PROVISIONER_IMAGE" -c 'rm -rf /mnt/libs/* /mnt/libs/.[!.]*' >/dev/null 2>&1
rm -f "$race_log"; rmdir "$race_root" 2>/dev/null

# ---------------------------------------------------------------------------
printf '\n%s\n' "-----------------------------------------------"
printf 'passed %d, failed %d\n' "$PASSED" "$FAILED"
[[ $FAILED -eq 0 ]] || exit 1
