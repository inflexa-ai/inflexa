#!/usr/bin/env bash
# Sandbox-level checks for the content-addressed store and the symlink farms.
#
# scripts/lib-store-provisioner-checks.sh drives the provisioner and proves the
# store operations. It never imports a package, because the provisioner has no
# farm-activating .pth and it is not the unprivileged reader. This sibling proves
# the other half: what the SANDBOX resolves through a provisioner-built farm.
#
# Each check names one way the design can be wrong at run time:
#   - a compiled C extension does not load through the farm links
#   - a vendored shared library does not resolve through an $ORIGIN-relative path
#   - distribution metadata does not resolve through the farm
#   - two farms that pin different versions do not stay isolated
#   - a prepared cache is present but not effective, so the runtime recompiles
#   - packages.txt names a package the farm does not actually serve
#   - an R package loads in the provisioner image and not in the sandbox image
#
# The provisioner builds each farm with the network on. Every check that reads a
# farm runs in the sandbox image with the sandbox posture: no network, uid 1000,
# all capabilities dropped, and the store read-only.
#
# The store carries no active-farm pointer. Thus every run that reads a farm takes
# that farm as a second bind at /mnt/libs/current, nested inside the store-root bind,
# the same as the harness gives a farm to a sandbox. The preparation of the caches
# takes the same bind, because a numba cache key holds the path of the source.
#
# Usage: scripts/lib-store-sandbox-checks.sh [--keep] [SECTION ...]
#   --keep     do not remove the throwaway store root at the end
#   SECTION    one or more of: imports validate cache isolation rload  (default: all)
# Env:
#   PROVISIONER_IMAGE   the provisioner to drive (default inflexa-provisioner:local)
#   SANDBOX_IMAGE       the sandbox to read with (default ghcr.io/inflexa-ai/sandbox-base:latest)
#   LIB_STORE           the throwaway store root (default a fresh mktemp -d)
#   CTR                 podman or docker (default: podman, then docker)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROVISIONER_IMAGE="${PROVISIONER_IMAGE:-inflexa-provisioner:local}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-ghcr.io/inflexa-ai/sandbox-base:latest}"
VALIDATE_DIR="$REPO_ROOT/scripts/lib-store-validate"

KEEP=0
SECTIONS=()
for arg in "$@"; do
    case "$arg" in
        --keep) KEEP=1 ;;
        imports|validate|cache|isolation|rload) SECTIONS+=("$arg") ;;
        all) SECTIONS=(imports validate cache isolation rload) ;;
        *) echo "error: unknown argument '$arg'" >&2; exit 1 ;;
    esac
done
[[ ${#SECTIONS[@]} -eq 0 ]] && SECTIONS=(imports validate cache isolation rload)

# Podman is the engine on the target platform, and docker is only a fallback.
CTR="${CTR:-}"
if [[ -z "$CTR" ]]; then
    if podman info >/dev/null 2>&1; then CTR=podman
    elif docker info >/dev/null 2>&1; then CTR=docker
    else echo "error: neither podman nor docker has a running daemon" >&2; exit 1
    fi
fi

for img in "$PROVISIONER_IMAGE" "$SANDBOX_IMAGE"; do
    "$CTR" image inspect "$img" >/dev/null 2>&1 || {
        echo "error: no image $img" >&2; exit 1; }
done

# A throwaway root, never the store of the user. The checks tamper with the content of
# the store, so they must not touch a store that a real sandbox reads.
STORE_ROOT="${LIB_STORE:-$(mktemp -d)}"
# The uid 1000 sandbox must traverse the store root. mktemp makes it mode 700, so
# open it, the same as the harness makes the store root the sandbox reads.
chmod 755 "$STORE_ROOT"

PASSED=0
FAILED=0
ok()    { printf '  PASS  %s\n' "$1"; PASSED=$((PASSED + 1)); }
bad()   { printf '  FAIL  %s\n' "$1"; [[ -n "${2:-}" ]] && printf '        %s\n' "$2"; FAILED=$((FAILED + 1)); }
head2() { printf '\n=== %s ===\n' "$1"; }

# The store mounts at /mnt/libs in each run, because a farm links to absolute targets
# under that path. A different mount point breaks every link.
run_net() { "$CTR" run --rm -v "$STORE_ROOT:/mnt/libs:rw" "$PROVISIONER_IMAGE" "$@" 2>&1; }

# A preparation run, which warms the caches of a farm that an earlier run published.
# It takes the farm as a second bind at /mnt/libs/current, the path the sandbox
# imports from, because a numba cache key holds the path of the source. The store
# carries no pointer, thus this bind is what puts the farm there.
#
# The farm is the first argument. Such a run passes no spec: a publish replaces the
# farm directory, and the bind of this container would then hold the directory that
# the publish superseded.
run_prepare() {
    local name="$1"; shift
    "$CTR" run --rm -v "$STORE_ROOT:/mnt/libs:rw" \
        -v "$STORE_ROOT/farms/$name:/mnt/libs/current:rw" \
        "$PROVISIONER_IMAGE" "$@" 2>&1
}

# A shell in the store, for the steps that must write as the provisioner wrote. A
# write from the host is not equal: on macOS a container that starts directly after a
# host write can read the old bytes, and a read from a container refreshes them.
in_store() { "$CTR" run --rm --network none -v "$STORE_ROOT:/mnt/libs:rw" \
             --entrypoint sh "$PROVISIONER_IMAGE" -c "$1" 2>&1; }

# Write a file into the store through a container, so the sandbox reads the bytes the
# same run wrote. The content arrives on stdin, and base64 keeps any quoting intact.
stage() {
    local path="$1" b64
    b64=$(base64 | tr -d '\n')
    in_store "printf %s '$b64' | base64 -d > '$path'" >/dev/null
}

# Both prepared caches must move out of the read-only store before use, because each
# library picks its cache directory by a write probe and rebuilds when it cannot write.
SANDBOX_PROLOGUE='cp -r /mnt/libs/current/matplotlib_config /tmp/mpl 2>/dev/null || mkdir -p /tmp/mpl
cp -r /mnt/libs/current/numba-cache /tmp/numba-cache 2>/dev/null || mkdir -p /tmp/numba-cache
export NUMBA_CACHE_DIR=/tmp/numba-cache
export PATH="$PATH:/mnt/libs/current/python/bin"'

# The farm that the sandbox runs resolve at /mnt/libs/current. Each section sets it
# before its first sandbox run, because each section reads a farm of its own.
SANDBOX_FARM=""

# The sandbox posture, unchanged: no network, uid 1000, every capability dropped, and
# the store read-only. `script` is the program to run; the rest passes to the engine,
# for example an extra read-only mount.
#
# The farm arrives as a second bind at /mnt/libs/current, nested inside the bind of
# the store root, the same as the harness gives a farm to a sandbox. The store carries
# no pointer, thus without that bind the baked .pth resolves nothing and the whole
# section reads an empty environment.
sandbox_run() {
    local script="$1"; shift
    local numba=()
    [[ -n "$SANDBOX_FARM" ]] || { echo "internal error: the section named no farm"; return 1; }
    # The value must match what the provisioner exported while it warmed, or every
    # cached numba entry misses.
    [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]] && numba=(-e NUMBA_CPU_NAME=generic)
    "$CTR" run --rm --network none \
        --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
        -v "$STORE_ROOT:/mnt/libs:ro" \
        -v "$STORE_ROOT/farms/$SANDBOX_FARM:/mnt/libs/current:ro" "$@" \
        "${numba[@]}" -e MPLCONFIGDIR=/tmp/mpl -w /tmp \
        --entrypoint /bin/bash "$SANDBOX_IMAGE" -c "$SANDBOX_PROLOGUE
$script" 2>&1
}

store_dirs() { ls -1 "$STORE_ROOT/store" 2>/dev/null | grep -v '^\.' ; }

cleanup() {
    "$CTR" rm -f sbx-lease >/dev/null 2>&1
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

echo "engine:  $CTR"
echo "provisioner: $PROVISIONER_IMAGE"
echo "sandbox: $SANDBOX_IMAGE"
echo "store:   $STORE_ROOT"
echo "run:     ${SECTIONS[*]}"

wants() { [[ " ${SECTIONS[*]} " == *" $1 "* ]]; }

# ---------------------------------------------------------------------------
# A farm with a compiled extension and a package that vendors its own shared
# libraries. numpy carries a compiled C extension; scipy loads a bundled BLAS
# through an $ORIGIN-relative RPATH, which only resolves when the farm links whole
# top-level entries out of one store directory.
if wants imports || wants validate; then
    head2 "a runtime farm (numpy, scipy)"
    out=$(run_net --farm rt numpy scipy); rc=$?
    if [[ $rc -ne 0 ]]; then
        bad "could not provision the runtime farm" "$(tail -5 <<<"$out")"
    else
        ok "the runtime farm is provisioned"
    fi
fi

if wants imports; then
    head2 "imports through the farm"
    SANDBOX_FARM=rt
    read -r -d '' FARM_IMPORTS <<'PY'
import importlib.metadata as im

def line(tag, ok, detail):
    print(f"{'PASS' if ok else 'FAIL'} {tag} {detail}")

try:
    import numpy as np
    d = int(np.dot([1, 2], [3, 4]))
    line("compiled", d == 11, f"numpy {np.__version__} dot={d}")
except Exception as exc:  # noqa: BLE001
    line("compiled", False, repr(exc))

try:
    from scipy import linalg
    import numpy as np
    det = linalg.det(np.array([[1.0, 2.0], [3.0, 4.0]]))
    line("origin", abs(det + 2.0) < 1e-9, f"scipy linalg.det={det:.3f}")
except Exception as exc:  # noqa: BLE001
    line("origin", False, repr(exc))

try:
    vs = {d: im.version(d) for d in ("numpy", "scipy")}
    line("metadata", all(vs.values()), ", ".join(f"{k}=={v}" for k, v in vs.items()))
except Exception as exc:  # noqa: BLE001
    line("metadata", False, repr(exc))
PY
    stage /mnt/libs/farm_imports.py <<<"$FARM_IMPORTS"
    out=$(sandbox_run "python3 /mnt/libs/farm_imports.py")
    for chk in compiled origin metadata; do
        detail=$(grep -E "^(PASS|FAIL) $chk " <<<"$out" | head -1)
        case "$chk" in
            compiled) label="a compiled C extension loads through the farm" ;;
            origin)   label="a vendored shared library resolves through \$ORIGIN" ;;
            metadata) label="distribution metadata resolves through the farm" ;;
        esac
        if grep -q "^PASS $chk " <<<"$out"; then ok "$label  ($detail)"
        else bad "$label" "${detail:-no output for $chk; tail: $(tail -2 <<<"$out")}"; fi
    done
fi

# ---------------------------------------------------------------------------
# packages.txt must not lie: every advertised package must load FROM the farm. The
# store-backed inventory drives the check, and validate.py confirms each Python
# module resolves under the content store, not a baked or system copy.
if wants validate; then
    head2 "validate.py against the farm"
    SANDBOX_FARM=rt
    out=$(sandbox_run "python3 /opt/lib-store-validate/validate.py --farm" \
          -v "$VALIDATE_DIR:/opt/lib-store-validate:ro"); rc=$?
    if [[ $rc -eq 0 ]] && grep -q "farm-backed" <<<"$out" && grep -q "GREEN" <<<"$out"; then
        ok "validate.py --farm confirms advertised packages load from the farm"
    else
        bad "validate.py --farm gave exit $rc" "$(tail -4 <<<"$out")"
    fi
fi

# ---------------------------------------------------------------------------
# A prepared cache must be effective, not merely present. The provisioner warms a
# small numba workload into the farm cache, and it records the entries that a later
# run reuses. The sandbox replays that recording with the cache debug on, and a write
# to a recorded entry means the runtime recompiled a prepared code path.
#
# scripts/lib-store-cache-check.py is that check, and the build runs the same file.
# The four runs below cover both halves of its judgment: each recorded entry loads,
# and a write outside the record passes.
if wants cache; then
    head2 "a warmed numba cache is effective"

    read -r -d '' WARM_KERNELS <<'PY'
import numpy as np
from numba import njit


@njit(cache=True)
def sum_squares(a):
    total = 0.0
    for i in range(a.shape[0]):
        total += a[i] * a[i]
    return total


@njit(cache=True)
def clip_relu(a):
    out = np.empty_like(a)
    for i in range(a.shape[0]):
        v = a[i]
        out[i] = v if v > 0.0 else 0.0
    return out
PY

    # The kernels live in a module beside the driver, so numba keys the cache on a
    # stable file path that both the warm-up and the replay import from /mnt/libs.
    read -r -d '' WARM_NUMBA <<'PY'
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402
import warm_kernels  # noqa: E402


def main():
    a = np.linspace(-1.0, 1.0, 4096)
    s = warm_kernels.sum_squares(a)
    r = warm_kernels.clip_relu(a)
    print(f"sum_squares={s:.3f} relu_sum={float(r.sum()):.3f}")


if __name__ == "__main__":
    main()
PY

    stage /mnt/libs/warm_kernels.py <<<"$WARM_KERNELS"
    stage /mnt/libs/warm_numba.py <<<"$WARM_NUMBA"

    # The check runs in the sandbox image, thus it arrives as a mount of the one
    # implementation. The build runs the same file against the store that it
    # published, and two implementations of it would not stay equal.
    cache_check() {
        sandbox_run "python3 /opt/lib-store-cache-check.py" \
            -v "$REPO_ROOT/scripts/lib-store-cache-check.py:/opt/lib-store-cache-check.py:ro"
    }

    SANDBOX_FARM=nb
    out=$(run_net --farm nb numpy numba); rc=$?
    if [[ $rc -ne 0 ]]; then
        bad "could not provision the numba farm" "$(tail -5 <<<"$out")"
    else
        ok "the numba farm is provisioned"

        # The preparation is a run of its own, with the farm bound at the path the
        # sandbox imports from. A run that published the farm would hold that bind on
        # the directory that its own publish superseded.
        out=$(run_prepare nb --farm nb --warm numba,numpy \
              --warm-script /mnt/libs/warm_numba.py); rc=$?
        if [[ $rc -ne 0 ]]; then
            bad "could not prepare the caches of the numba farm" "$(tail -5 <<<"$out")"
        else
            ok "the caches are prepared through the bound farm  ($(grep -o '[0-9]* cache entry(s) recorded' <<<"$out" | tail -1))"

            out=$(cache_check); rc=$?
            if [[ $rc -eq 0 ]] && grep -q "PASS:" <<<"$out"; then
                ok "each recorded entry loads, and nothing recompiles  ($(grep 'PASS:' <<<"$out" | tail -1))"
            else
                bad "the replay observed a run-time recompile or an error" "$(tail -4 <<<"$out")"
            fi

            # A kernel that the preparation cannot carry forward writes at run time,
            # and the record holds no entry for it. One entry that leaves the disk and
            # the record has that same shape, thus the check reports it and passes.
            entry=$(in_store 'python3 - <<PY
import json
from pathlib import Path
farm = Path("/mnt/libs/farms/nb")
lock = json.loads((farm / "lock.json").read_text())
entry = lock["warm_workload"]["cache_entries"].pop(0)
(farm / "numba-cache" / entry).unlink()
(farm / "lock.json").write_text(json.dumps(lock, indent=2))
print(entry)
PY' | tail -1 | tr -d '\r')
            out=$(cache_check); rc=$?
            if [[ $rc -eq 0 ]] && grep -q "no run reuses" <<<"$out"; then
                ok "a write outside the recorded set is reported, and it passes"
            else
                bad "a write outside the recorded set did not pass (exit $rc)" "$(tail -4 <<<"$out")"
            fi

            # The same missing entry, back in the record. A prepared code path that
            # compiles again at run time is the defect this whole section exists for,
            # thus the check must fail on it.
            in_store "python3 - <<PY
import json
from pathlib import Path
farm = Path('/mnt/libs/farms/nb')
lock = json.loads((farm / 'lock.json').read_text())
lock['warm_workload']['cache_entries'].append('$entry')
(farm / 'lock.json').write_text(json.dumps(lock, indent=2))
PY" >/dev/null
            out=$(cache_check); rc=$?
            if [[ $rc -eq 1 ]] && grep -q "compiled again" <<<"$out"; then
                ok "a recorded entry that recompiles fails the check"
            else
                bad "a recompiled entry of the record did not fail (exit $rc)" "$(tail -4 <<<"$out")"
            fi

            # The check must reject a script whose bytes drifted from the record. A
            # changed byte at the recorded path is a different workload, and a replay
            # of it would exercise an unprepared call and fail for the wrong reason.
            in_store 'printf "\n# drift\n" >> /mnt/libs/warm_numba.py' >/dev/null 2>&1
            out=$(cache_check); rc=$?
            if [[ $rc -ne 0 ]] && grep -q "bytes differ" <<<"$out"; then
                ok "a drifted warm script fails the byte confirm before the replay"
            else
                bad "a drifted warm script did not fail the confirm (exit $rc)" "$(tail -3 <<<"$out")"
            fi
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Two farms that pin different versions of one distribution must stay isolated. The
# store keeps both versions, and each farm resolves the version its own closure
# pinned.
if wants isolation; then
    head2 "farm isolation across two versions"
    OLD=1.16.0
    NEW=1.17.0

    out=$(run_net --farm iso-old "six==$OLD"); rc=$?
    if [[ $rc -ne 0 ]]; then
        bad "could not provision the old farm" "$(tail -5 <<<"$out")"
    else
        # Each of the two runs below binds its own farm at /mnt/libs/current, which is
        # what makes the two versions resolve at the same path in two containers.
        SANDBOX_FARM=iso-old
        got=$(sandbox_run 'python3 -c "import importlib.metadata as im; print(im.version(\"six\"))"' | tail -1 | tr -d '\r')
        if [[ "$got" == "$OLD" ]]; then ok "the old farm resolves six==$OLD"
        else bad "the old farm resolved '$got', not $OLD"; fi

        out=$(run_net --farm iso-new "six==$NEW"); rc=$?
        if [[ $rc -ne 0 ]]; then
            bad "could not provision the new farm" "$(tail -5 <<<"$out")"
        else
            SANDBOX_FARM=iso-new
            got=$(sandbox_run 'python3 -c "import importlib.metadata as im; print(im.version(\"six\"))"' | tail -1 | tr -d '\r')
            if [[ "$got" == "$NEW" ]]; then ok "the new farm resolves six==$NEW"
            else bad "the new farm resolved '$got', not $NEW"; fi

            dirs=$(store_dirs)
            if grep -q "^six-$OLD-" <<<"$dirs" && grep -q "^six-$NEW-" <<<"$dirs"; then
                ok "the store keeps both versions side by side"
            else
                bad "the store does not hold both versions" "$(tr '\n' ' ' <<<"$dirs")"
            fi

            # The new farm did not mutate the old one: the old farm's link still
            # targets the old version's store directory.
            tgt=$(in_store 'readlink /mnt/libs/farms/iso-old/python/site-packages/six.py 2>/dev/null || readlink /mnt/libs/farms/iso-old/python/site-packages/six 2>/dev/null')
            if grep -q "six-$OLD-" <<<"$tgt"; then
                ok "the old farm still links the old version, untouched"
            else
                bad "the old farm's link changed" "$tgt"
            fi
        fi
    fi
fi

# ---------------------------------------------------------------------------
# The R load check belongs to the SANDBOX image. The provisioner image installs pak
# and yaml into its own site library, thus a check that runs there resolves two names
# that no farm carries. This section proves the difference with two small packages:
# config imports yaml, and only the provisioner owns yaml when the farm loses it.

# The check reads the farm at /mnt/libs/current, the path a sandbox resolves, thus the
# run takes the store root and the farm as two mounts. `image` is the first argument,
# so the same check runs in either image and the two answers are comparable. The
# posture is the posture of a sandbox: no network, uid 1000, and no capability.
r_load_check() {
    local image="$1" farm="$2"
    "$CTR" run --rm --network none \
        --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
        -v "$STORE_ROOT:/mnt/libs:ro" \
        -v "$STORE_ROOT/farms/$farm:/mnt/libs/current:ro" \
        -v "$REPO_ROOT/scripts/lib-store-r-load-check.py:/opt/lib-store-r-load-check.py:ro" \
        --entrypoint python3 "$image" /opt/lib-store-r-load-check.py 2>&1
}

if wants rload; then
    head2 "the R load check in the sandbox image"

    read -r -d '' R_MANIFEST <<'YAML'
r:
  cran:
    - config
YAML
    stage /mnt/libs/r-manifest.yaml <<<"$R_MANIFEST"

    out=$(run_net --farm rload --r-manifest /mnt/libs/r-manifest.yaml); rc=$?
    if [[ $rc -ne 0 ]]; then
        bad "could not provision the R farm" "$(tail -5 <<<"$out")"
    else
        ok "the R farm is provisioned (config, yaml)"

        out=$(r_load_check "$SANDBOX_IMAGE" rload); rc=$?
        if [[ $rc -eq 0 ]] && grep -q "PASS:" <<<"$out"; then
            ok "each farmed R package loads in the sandbox image  ($(grep 'PASS:' <<<"$out" | tail -1))"
        else
            bad "a farm that carries its whole closure did not pass (exit $rc)" "$(tail -4 <<<"$out")"
        fi

        # The shape of the defect: the dependency leaves the farm, and it leaves the
        # record with the link. What remains is a package whose runtime dependency
        # only the provisioner image owns.
        in_store 'python3 - <<PY
import json
from pathlib import Path
farm = Path("/mnt/libs/farms/rload")
lock = json.loads((farm / "lock.json").read_text())
lock["r"]["farmed"] = [e for e in lock["r"]["farmed"] if e["name"] != "yaml"]
(farm / "lock.json").write_text(json.dumps(lock, indent=2))
(farm / "r" / "cran" / "yaml").unlink()
PY' >/dev/null

        out=$(r_load_check "$SANDBOX_IMAGE" rload); rc=$?
        if [[ $rc -eq 1 ]] && grep -q "^FAIL config " <<<"$out"; then
            ok "a dependency that only the provisioner owns fails the check"
        else
            bad "the sandbox image passed a farm that lost a dependency (exit $rc)" "$(tail -4 <<<"$out")"
        fi

        # The same farm inside the provisioner image: yaml resolves from the site
        # library of that image, thus the check passes there and proves nothing about
        # the sandbox. That is the reason the check moved.
        out=$(r_load_check "$PROVISIONER_IMAGE" rload); rc=$?
        if [[ $rc -eq 0 ]]; then
            ok "the same farm passes inside the provisioner image, which owns yaml"
        else
            bad "the provisioner image did not resolve yaml from its own library (exit $rc)" "$(tail -4 <<<"$out")"
        fi
    fi
fi

# ---------------------------------------------------------------------------
printf '\n%s\n' "-----------------------------------------------"
printf 'passed %d, failed %d\n' "$PASSED" "$FAILED"
[[ $FAILED -eq 0 ]] || exit 1
