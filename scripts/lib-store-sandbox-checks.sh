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
#
# The provisioner builds each farm with the network on. Every check that reads a
# farm runs in the sandbox image with the sandbox posture: no network, uid 1000,
# all capabilities dropped, and the store read-only.
#
# Usage: scripts/lib-store-sandbox-checks.sh [--keep] [SECTION ...]
#   --keep     do not remove the throwaway store root at the end
#   SECTION    one or more of: imports validate cache isolation  (default: all)
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
        imports|validate|cache|isolation) SECTIONS+=("$arg") ;;
        all) SECTIONS=(imports validate cache isolation) ;;
        *) echo "error: unknown argument '$arg'" >&2; exit 1 ;;
    esac
done
[[ ${#SECTIONS[@]} -eq 0 ]] && SECTIONS=(imports validate cache isolation)

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

# A throwaway root, never the store of the user. The checks tamper with content and
# swing `current`, so they must not touch a store that a real sandbox reads.
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

# The sandbox posture, unchanged: no network, uid 1000, every capability dropped, and
# the store read-only. `script` is the program to run; the rest passes to the engine,
# for example an extra read-only mount.
sandbox_run() {
    local script="$1"; shift
    local numba=()
    # The value must match what the provisioner exported while it warmed, or every
    # cached numba entry misses.
    [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]] && numba=(-e NUMBA_CPU_NAME=generic)
    "$CTR" run --rm --network none \
        --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
        -v "$STORE_ROOT:/mnt/libs:ro" "$@" \
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
# small numba workload into the farm cache. The sandbox replays exactly that
# recording with the cache debug on, and a save at run time means the runtime
# recompiled a prepared code path.
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

    read -r -d '' REPLAY_CHECK <<'PY'
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

farm = Path("/mnt/libs/current")
lock = json.loads((farm / "lock.json").read_text())
script = lock.get("warm_script")
if not script:
    print("FAIL: the farm recorded no warm_script")
    sys.exit(1)

recorded = (lock.get("warm_workload") or {}).get("script_sha256")
actual = hashlib.sha256(Path(script).read_bytes()).hexdigest()
if recorded != actual:
    print(f"FAIL: the warm script bytes differ from the record "
          f"(recorded {recorded}, actual {actual})")
    sys.exit(1)

# NUMBA_DEBUG_CACHE makes the locator report every load and every save. A save here
# means the entry recompiled at run time, so the warm-up did not carry over.
proc = subprocess.run([sys.executable, script], capture_output=True, text=True,
                      env={**os.environ, "NUMBA_DEBUG_CACHE": "1"})
if proc.returncode != 0:
    print("FAIL: the replay run errored:\n" + proc.stderr.strip()[-400:])
    sys.exit(1)

out = proc.stdout + proc.stderr
loads = out.count("data loaded")
saves = out.count("data saved")
if loads <= 0:
    print(f"FAIL: no cache loads at all ({saves} saves)")
    sys.exit(1)
if saves != 0:
    print(f"FAIL: {saves} entries recompiled despite the warm-up ({loads} loaded)")
    sys.exit(1)
print(f"PASS: {loads} cached compilations loaded, 0 recompiled")
PY

    stage /mnt/libs/warm_kernels.py <<<"$WARM_KERNELS"
    stage /mnt/libs/warm_numba.py <<<"$WARM_NUMBA"
    stage /mnt/libs/replay_check.py <<<"$REPLAY_CHECK"

    out=$(run_net --farm nb --warm numba,numpy --warm-script /mnt/libs/warm_numba.py numpy numba); rc=$?
    if [[ $rc -ne 0 ]]; then
        bad "could not provision and warm the numba farm" "$(tail -5 <<<"$out")"
    else
        ok "the numba farm is provisioned and warmed"

        out=$(sandbox_run "python3 /mnt/libs/replay_check.py"); rc=$?
        if [[ $rc -eq 0 ]] && grep -q "^PASS" <<<"$out"; then
            ok "the replay loads the cache and writes nothing  ($(grep '^PASS' <<<"$out"))"
        else
            bad "the replay observed a run-time recompile or an error" "$(tail -4 <<<"$out")"
        fi

        # The confirm must reject a script whose bytes drifted from the record. A
        # changed byte at the recorded path is a different workload, and a replay of
        # it would test an unprepared call and fail for the wrong reason.
        in_store 'printf "\n# drift\n" >> /mnt/libs/warm_numba.py' >/dev/null 2>&1
        out=$(sandbox_run "python3 /mnt/libs/replay_check.py"); rc=$?
        if [[ $rc -ne 0 ]] && grep -q "bytes differ" <<<"$out"; then
            ok "a drifted warm script fails the byte confirm before the replay"
        else
            bad "a drifted warm script did not fail the confirm (exit $rc)" "$(tail -3 <<<"$out")"
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
        got=$(sandbox_run 'python3 -c "import importlib.metadata as im; print(im.version(\"six\"))"' | tail -1 | tr -d '\r')
        if [[ "$got" == "$OLD" ]]; then ok "the old farm resolves six==$OLD"
        else bad "the old farm resolved '$got', not $OLD"; fi

        out=$(run_net --farm iso-new "six==$NEW"); rc=$?
        if [[ $rc -ne 0 ]]; then
            bad "could not provision the new farm" "$(tail -5 <<<"$out")"
        else
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
printf '\n%s\n' "-----------------------------------------------"
printf 'passed %d, failed %d\n' "$PASSED" "$FAILED"
[[ $FAILED -eq 0 ]] || exit 1
