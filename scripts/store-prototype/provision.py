#!/usr/bin/env python3
"""Turn a list of package specs into files on disk. Runs inside the provisioner.

The provisioner is the only container with network access and the only one with a
compiler. It mounts the library store and nothing else, so there is no user data
here to leak to the network it is allowed to reach.

One host directory, three roles, all under the path the harness already knows as
`libStorePath` and bind-mounts read-only at /mnt/libs:

  /mnt/libs/store/<name>-<version>-<hash>/
        Content-addressed, write-once, one directory per installed distribution.
        Ten analyses using scanpy share one copy.

  /mnt/libs/farms/<analysis>/
        One symlink farm per analysis — its dependency closure and nothing else.
        Its interior is the layout the sandbox images already bake:
        python/site-packages, r/{cran,bioconductor,github}, node/node_modules, conda.

  /mnt/libs/current -> farms/<analysis>
        The pointer `libStoreUsable` resolves. Flipping it selects which farm the
        next sandbox sees.

That /mnt/libs is mounted at the SAME path here (read-write) and in the sandbox
(read-only) is the load-bearing detail. It is what makes a farm symlink written
here resolve there, and it is why cache warm-up can run here at all: numba's
in-tree cache locator needs the store writable at the path the sandbox will
later read.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

LIBS = Path(os.environ.get("LIB_ROOT", "/mnt/libs"))
STORE = LIBS / "store"
FARMS = LIBS / "farms"

# The sandbox runs the system interpreter, so resolution and the compiled
# extension suffixes have to be pinned to it, not to whatever uv would pick.
PYTHON = "/usr/bin/python3"

# Marker written inside each store directory recording the exact pin it was
# installed from, so a name+version glob can be confirmed rather than trusted.
PIN_MARKER = ".inflexa-pin"

# Never part of a distribution's content and never farmed: `.lock` is uv's own
# per-target mutex, identical in every install, so farming it makes every package
# after the first collide on it.
NOT_CONTENT = {PIN_MARKER, ".lock"}

# Derived data that must not participate in the content address: warm-up writes
# numba's compiled artifacts and CPython bytecode into the tree AFTER the hash is
# taken, and an address that moved underneath them would defeat all reuse.
HASH_EXCLUDE_DIRS = {"__pycache__"}
HASH_EXCLUDE_SUFFIX = (".pyc", ".nbi", ".nbc")


def log(msg: str) -> None:
    print(f"[provision] {msg}", flush=True)


def canon(name: str) -> str:
    """PEP 503 normalized distribution name."""
    return re.sub(r"[-_.]+", "-", name).lower()


def tree_hash(root: Path) -> str:
    """Content address of an installed distribution.

    Covers relative path, file bytes, the executable bit, and symlink targets —
    everything that changes what the sandbox will load.
    """
    h = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda p: str(p.relative_to(root))):
        rel = path.relative_to(root)
        if (HASH_EXCLUDE_DIRS & set(rel.parts) or path.name.endswith(HASH_EXCLUDE_SUFFIX)
                or rel.parts[0] in NOT_CONTENT):
            continue
        h.update(str(rel).encode())
        if path.is_symlink():
            h.update(b"\0L" + os.readlink(path).encode())
        elif path.is_file():
            h.update(b"\0F" + hashlib.sha256(path.read_bytes()).digest())
            h.update(b"X" if path.stat().st_mode & 0o111 else b"-")
        else:
            h.update(b"\0D")
        h.update(b"\n")
    return h.hexdigest()


def resolve(specs: list[str]) -> list[str]:
    """Full dependency closure of `specs`, as pinned name==version strings."""
    req = Path("/tmp/requirements.in")
    req.write_text("\n".join(specs) + "\n")
    out = Path("/tmp/requirements.txt")
    log(f"resolving closure of: {', '.join(specs)}")
    subprocess.run(
        ["uv", "pip", "compile", "--python", PYTHON, "--no-header", "--quiet",
         str(req), "-o", str(out)],
        check=True,
    )
    pins = []
    for line in out.read_text().splitlines():
        line = line.split("#", 1)[0].strip().rstrip("\\").strip()
        # Markers were already evaluated against this interpreter by the compile
        # step; whatever follows `;` is noise for the install call.
        line = line.split(";", 1)[0].strip()
        if line and "==" in line:
            pins.append(line)
    log(f"closure: {len(pins)} distributions")
    return sorted(pins)


def find_stored(pin: str) -> Path | None:
    """An existing store directory holding exactly this pin, if there is one."""
    name, version = pin.split("==", 1)
    for candidate in sorted(STORE.glob(f"{canon(name)}-{version}-*")):
        marker = candidate / PIN_MARKER
        if marker.is_file() and marker.read_text().strip() == pin:
            return candidate
    return None


def ensure_stored(pin: str) -> tuple[Path, bool]:
    """Return the store directory for `pin`, installing it if absent."""
    existing = find_stored(pin)
    if existing is not None:
        return existing, False

    name, version = pin.split("==", 1)
    # Staged inside the store, not under /tmp: publishing is a rename, and a
    # rename is only atomic within one filesystem. The store is a bind mount, so
    # anywhere else is a different device and the publish would have to be a copy.
    staging = STORE / ".staging" / canon(name)
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)

    log(f"installing {pin}")
    subprocess.run(
        ["uv", "pip", "install", "--python", PYTHON, "--no-deps", "--no-cache",
         "--break-system-packages", "--target", str(staging), pin],
        check=True,
    )

    digest = tree_hash(staging)[:16]
    final = STORE / f"{canon(name)}-{version}-{digest}"
    if final.exists():
        # A different pin string produced byte-identical content; keep one copy.
        shutil.rmtree(staging)
        return final, False

    (staging / PIN_MARKER).write_text(pin + "\n")
    # The sandbox reads this tree as uid 1000, which under rootless podman is a
    # different subuid than the one that wrote it. World-readable is what makes
    # it legible there, and matches what the baked images already do.
    subprocess.run(["chmod", "-R", "a+rX", str(staging)], check=True)
    staging.rename(final)
    return final, True


def link_tree(dst: Path, src: str, collisions: list[str]) -> None:
    """Symlink every entry of `src` into `dst`, merging directories on collision.

    Two distributions sharing a top-level name — a namespace package like
    `mpl_toolkits` or `google` — cannot both be a symlink at the same point, so
    the shared prefix is promoted to a real directory and both sides are linked
    beneath it. That promotion is the only reason the farm holds real directories.

    Linking at top-level-entry granularity, rather than per file, is what keeps
    `$ORIGIN`-relative RPATHs working: a wheel's vendored `numpy.libs` and its
    `numpy/` package come from the same store directory, so `$ORIGIN/../numpy.libs`
    resolves inside that directory exactly as the wheel intended.
    """
    for entry in sorted(os.listdir(src)):
        if entry in NOT_CONTENT:
            continue
        target = f"{src}/{entry}"
        link = dst / entry

        if not link.is_symlink() and not link.exists():
            link.symlink_to(target)
        elif link.is_symlink():
            previous = os.readlink(link)
            if os.path.isdir(previous) and os.path.isdir(target):
                link.unlink()
                link.mkdir()
                link_tree(link, previous, collisions)
                link_tree(link, target, collisions)
            else:
                collisions.append(f"{entry}: {previous} vs {target} (kept first)")
        elif link.is_dir() and os.path.isdir(target):
            link_tree(link, target, collisions)
        else:
            collisions.append(f"{entry}: already a file, skipped {target}")


def build_farm(farm: Path, store_dirs: list[Path]) -> list[str]:
    """Assemble the per-analysis symlink farm from its closure's store dirs."""
    if farm.exists():
        shutil.rmtree(farm)
    site = farm / "python" / "site-packages"
    site.mkdir(parents=True)
    # conda is deliberately never farmed: its binaries carry their build prefix
    # compiled in, so a prefix is bind-mounted whole at the exact path it was
    # created for rather than relocated link by link. The directory exists only to
    # be that mount point.
    #
    # The r/ and node/ subtrees are NOT pre-created. inflexa-libs-refresh derives
    # one packages.txt section per subtree that exists, so an empty directory here
    # would advertise an empty "R (CRAN)" track to list_available_packages.
    (farm / "conda").mkdir(parents=True, exist_ok=True)

    collisions: list[str] = []
    for store_dir in store_dirs:
        link_tree(site, str(store_dir), collisions)

    # Console scripts land in <target>/bin under `uv pip install --target`; hoist
    # them so the sandbox can put a single directory on PATH.
    if (site / "bin").is_dir():
        binroot = farm / "python" / "bin"
        binroot.mkdir(parents=True, exist_ok=True)
        link_tree(binroot, str((site / "bin").resolve()), collisions)

    log(f"farm: {len(list(site.iterdir()))} top-level entries, {len(collisions)} collision(s)")
    for c in collisions:
        log(f"  collision {c}")
    return collisions


def warm(farm: Path, modules: list[str], script: str | None) -> dict[str, str]:
    """Pre-build numba JIT and matplotlib font caches into the store.

    numba's caches are written to NUMBA_CACHE_DIR rather than in-tree, because an
    in-tree cache is unreachable at runtime: numba selects a cache locator by
    trying to WRITE to it, so on a store the sandbox mounts read-only the in-tree
    locator is skipped entirely — for reads as well as writes — and everything
    recompiles. Measured: a read-only cache directory produces 30 saves and 0
    loads; the same directory made writable produces 30 loads and 0 saves. So the
    cache is built here into the farm, and the sandbox copies it to a writable
    path before use.

    Importing a module is NOT enough to populate it. numba compiles at first CALL,
    so an import-only warm-up leaves the cache empty — measured 0 cache files after
    importing numba, scanpy and matplotlib. Pass --warm-script to exercise the code
    paths an analysis will actually hit.
    """
    # Warm through /mnt/libs/current, NOT through the farm's own path. numba's
    # cache index key includes the source file's path, so warming via
    # /mnt/libs/farms/<name>/... produces keys the sandbox — which imports via
    # /mnt/libs/current/... — will never match. Measured: warming through the farm
    # path yields 0 loads and 29 recompiles; through `current`, 29 loads and 0.
    env = dict(os.environ)
    env["PYTHONPATH"] = str(LIBS / "current" / "python" / "site-packages")
    env["MPLCONFIGDIR"] = str(farm / "matplotlib_config")
    env["NUMBA_CACHE_DIR"] = str(farm / "numba-cache")
    if os.uname().machine == "aarch64":
        # Autodetecting the host CPU crashes LLVM codegen on newer arm64 cores.
        # The sandbox must set the identical value or every cache entry misses.
        env["NUMBA_CPU_NAME"] = "generic"
    Path(env["MPLCONFIGDIR"]).mkdir(parents=True, exist_ok=True)
    Path(env["NUMBA_CACHE_DIR"]).mkdir(parents=True, exist_ok=True)

    jobs = [(m, ["-c", f"import {m}"]) for m in modules]
    if script:
        jobs.append((f"script:{Path(script).name}", [script]))

    results = {}
    for label, argv in jobs:
        started = time.monotonic()
        proc = subprocess.run([PYTHON, *argv], env=env, capture_output=True, text=True)
        elapsed = time.monotonic() - started
        if proc.returncode == 0:
            results[label] = f"ok in {elapsed:.1f}s"
        else:
            tail = proc.stderr.strip().splitlines()
            results[label] = f"FAILED: {tail[-1] if tail else '?'}"
        log(f"  warm {label}: {results[label]}")

    cached = len(list(Path(env["NUMBA_CACHE_DIR"]).rglob("*.nbi")))
    log(f"  numba cache: {cached} index file(s)")
    results["_numba_cache_entries"] = str(cached)
    return results


def main() -> int:
    ap = argparse.ArgumentParser(description="Provision packages into the library store.")
    ap.add_argument("--farm", required=True, help="analysis name (farm directory)")
    ap.add_argument("--warm", default="", help="comma-separated modules to import during warm-up")
    ap.add_argument("--warm-script", default=None,
                    help="path (inside the store) to a script that exercises jitted code paths")
    ap.add_argument("specs", nargs="*", help="requirement specs to add")
    args = ap.parse_args()

    STORE.mkdir(parents=True, exist_ok=True)
    FARMS.mkdir(parents=True, exist_ok=True)

    farm = FARMS / args.farm
    lock_path = farm / "lock.json"

    previous: list[str] = []
    if lock_path.is_file():
        previous = json.loads(lock_path.read_text()).get("requested", [])

    requested = sorted(set(previous) | set(args.specs))
    if not requested:
        log("nothing requested and no existing lock — nothing to do")
        return 2

    pins = resolve(requested)

    store_dirs, added = [], []
    for pin in pins:
        path, is_new = ensure_stored(pin)
        store_dirs.append(path)
        if is_new:
            added.append(pin)
    log(f"{len(added)} newly installed, {len(pins) - len(added)} reused from store")
    shutil.rmtree(STORE / ".staging", ignore_errors=True)

    collisions = build_farm(farm, store_dirs)

    # Flip `current` BEFORE warming, so the warm-up runs against the exact path
    # the sandbox will import from (see the note in warm()).
    current = LIBS / "current"
    if current.is_symlink() or current.exists():
        current.unlink()
    current.symlink_to(f"farms/{args.farm}")

    warm_targets = [m for m in args.warm.split(",") if m]
    warm_results = warm(farm, warm_targets, args.warm_script) if (warm_targets or args.warm_script) else {}

    # The same producer the images use, so packages.txt is byte-identical in shape
    # to what list_available_packages already parses.
    subprocess.run(["/usr/local/bin/inflexa-libs-refresh", "--rederive"],
                   env={**os.environ, "INFLEXA_LIB_ROOT": str(farm)}, check=True)

    # Second of the two completeness markers libStoreUsable requires before it
    # will bind the store; without it the mount is silently dropped.
    (farm / "meta.json").write_text(json.dumps({
        "version": args.farm,
        "arch": f"linux-{'arm64' if os.uname().machine == 'aarch64' else 'amd64'}",
        "tracks": ["python"],
    }, indent=2) + "\n")

    lock_path.write_text(json.dumps({
        "requested": requested,
        "resolved": pins,
        "store_dirs": [d.name for d in store_dirs],
        "collisions": collisions,
        # Recorded so a cache check can replay exactly what was warmed. numba keys
        # its cache per type signature, so only the call shapes this script
        # actually executed are cached; any other shape recompiles.
        "warm_script": args.warm_script,
        "warm": warm_results,
    }, indent=2) + "\n")

    subprocess.run(["chmod", "-R", "a+rX", str(farm)], check=True)
    log(f"farm '{args.farm}' ready: {len(pins)} distributions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
