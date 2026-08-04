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

# The path the sandbox mounts the store at, read-only. The provisioner must see the
# store at this SAME path — the design's load-bearing detail — because a farm's
# symlinks bake it as an absolute target the sandbox has to resolve.
SANDBOX_MOUNT = Path(os.environ.get("SANDBOX_LIB_MOUNT", "/mnt/libs"))

# The sandbox runs the system interpreter, so resolution and the compiled
# extension suffixes have to be pinned to it, not to whatever uv would pick.
PYTHON = "/usr/bin/python3"

# The one package index the provisioner may resolve and download from. Pinning it
# stops a dependency from pulling an artifact off an unexpected host, and every
# install runs under `--require-hashes`, so a substituted artifact fails its hash
# check rather than installing. The provisioner image enforces the same boundary at
# the network layer (its egress firewall allows only this host); this is the
# resolver-level half of that guarantee.
INDEX_URL = os.environ.get("INFLEXA_INDEX_URL", "https://pypi.org/simple")

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


def resolve(specs: list[str]) -> dict[str, list[str]]:
    """Full dependency closure of `specs`, as pinned name==version -> source hashes.

    `--generate-hashes` records a hash for every resolved artifact, and the install
    step enforces it with `--require-hashes`. Together they close the gap a content
    address alone leaves open: the address proves the installed tree is intact, the
    source hash proves the artifact it was built from was not substituted upstream.
    Resolution runs against the pinned index only, with `--no-config` so no ambient
    configuration can add another; a resolved requirement carrying a URL — an
    artifact from an unexpected host — fails the resolve.
    """
    req = Path("/tmp/requirements.in")
    req.write_text("\n".join(specs) + "\n")
    out = Path("/tmp/requirements.txt")
    log(f"resolving closure of: {', '.join(specs)}")
    subprocess.run(
        ["uv", "pip", "compile", "--python", PYTHON, "--no-header", "--quiet",
         "--generate-hashes", "--index-url", INDEX_URL, "--no-config",
         str(req), "-o", str(out)],
        check=True,
    )
    pins: dict[str, list[str]] = {}
    current: str | None = None
    for raw in out.read_text().splitlines():
        line = raw.split("#", 1)[0].strip().rstrip("\\").strip()
        if not line:
            continue
        if line.startswith("--hash="):
            if current is not None:
                pins[current].append(line[len("--hash="):])
            continue
        # A resolved requirement must be `name==version` from the pinned index. A URL
        # or VCS requirement here means a dependency resolved off-index; fail rather
        # than silently drop it (the tokens check below would) or install it from an
        # unexpected host. This is the resolved-output half of the pinned-index guard.
        if "://" in line:
            raise SystemExit(f"[provision] resolved artifact from an unexpected host: {line!r}")
        # A requirement line: `name==version`, possibly trailed by an environment
        # marker or an inline `--hash=`. Markers were already evaluated against this
        # interpreter by the compile step.
        tokens = line.split(";", 1)[0].split()
        if not tokens or "==" not in tokens[0]:
            continue
        current = tokens[0]
        pins.setdefault(current, [])
        for tok in tokens[1:]:
            if tok.startswith("--hash="):
                pins[current].append(tok[len("--hash="):])
    log(f"closure: {len(pins)} distributions")
    return dict(sorted(pins.items()))


def find_stored(pin: str) -> Path | None:
    """An existing store directory holding exactly this pin, if there is one."""
    name, version = pin.split("==", 1)
    for candidate in sorted(STORE.glob(f"{canon(name)}-{version}-*")):
        marker = candidate / PIN_MARKER
        if marker.is_file() and marker.read_text().strip() == pin:
            return candidate
    return None


def ensure_stored(pin: str, hashes: list[str]) -> tuple[Path, bool]:
    """Return the store directory for `pin`, installing it if absent.

    Install runs under `--require-hashes`: the pin is written to a fragment with its
    source hashes, and uv refuses an artifact whose download matches none of them. A
    pin that reached here without a hash fails loudly rather than installing
    unverified.
    """
    existing = find_stored(pin)
    if existing is not None:
        return existing, False

    name, version = pin.split("==", 1)
    if not hashes:
        raise SystemExit(f"[provision] refusing to install {pin} without a source hash")
    # Staged inside the store, not under /tmp: publishing is a rename, and a
    # rename is only atomic within one filesystem. The store is a bind mount, so
    # anywhere else is a different device and the publish would have to be a copy.
    staging = STORE / ".staging" / canon(name)
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)

    # A one-line requirements fragment carrying the pin and its hashes, because
    # `--require-hashes` reads hashes from a file, not from the command line.
    frag = Path("/tmp") / f"req-{canon(name)}.txt"
    frag.write_text(pin + "".join(f" --hash={h}" for h in hashes) + "\n")

    log(f"installing {pin}")
    subprocess.run(
        ["uv", "pip", "install", "--python", PYTHON, "--no-deps", "--no-cache",
         "--require-hashes", "--index-url", INDEX_URL, "--no-config",
         "--break-system-packages", "--target", str(staging), "-r", str(frag)],
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
    # A farm's links are absolute targets under LIBS, and the sandbox resolves them
    # at its own mount. They line up only when the provisioner sees the store at the
    # same path the sandbox will — /mnt/libs in both. A store rooted elsewhere would
    # bake a host path that resolves to nothing in the sandbox, so refuse to farm it.
    if LIBS != SANDBOX_MOUNT:
        raise SystemExit(
            f"[provision] refusing to build a farm: store root {LIBS} is not the "
            f"sandbox mount {SANDBOX_MOUNT}; farm links would bake a path the sandbox "
            f"cannot resolve (set SANDBOX_LIB_MOUNT if the sandbox mounts elsewhere)")
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


# --- R track -----------------------------------------------------------------
# R installs differently from Python: pak resolves and installs the bulk (CRAN +
# Bioconductor + git) as one lockfile via images/gen-r-lock.R, then GitHub installs
# incrementally on top. Once installed, each R package DIRECTORY is content-addressed
# and farmed exactly like a Python distribution — measured, an installed R package
# holds no reference to its install path, so relocation by symlink is safe.

R_SUBTREES = ("cran", "bioconductor", "github")


def read_r_pkg(pkg_dir: Path) -> tuple[str, str]:
    """(Package, Version) read from an installed R package's DESCRIPTION."""
    name = version = None
    for line in (pkg_dir / "DESCRIPTION").read_text(errors="replace").splitlines():
        if line.startswith("Package:"):
            name = line.split(":", 1)[1].strip()
        elif line.startswith("Version:"):
            version = line.split(":", 1)[1].strip()
        if name and version:
            break
    if not name or not version:
        raise SystemExit(f"[provision] R package at {pkg_dir}: DESCRIPTION lacks Package/Version")
    return name, version


def store_r_package(pkg_dir: Path) -> tuple[Path, bool]:
    """Content-address an already-installed R package directory into the store.

    Like ensure_stored, but pak already built the package into the staging library,
    so this only hashes the tree, writes the pin marker, and publishes by rename.
    pkg_dir must live under the store's filesystem (the staging root does), so the
    rename stays on one device. Reuse is by content and pin, exactly as for Python:
    two farms resolving the same version share one store directory.
    """
    name, version = read_r_pkg(pkg_dir)
    pin = f"{name}=={version}"
    existing = find_stored(pin)
    if existing is not None:
        return existing, False
    digest = tree_hash(pkg_dir)[:16]   # no PIN_MARKER yet; tree_hash excludes it regardless
    final = STORE / f"{canon(name)}-{version}-{digest}"
    if final.exists():
        return final, False
    (pkg_dir / PIN_MARKER).write_text(pin + "\n")
    subprocess.run(["chmod", "-R", "a+rX", str(pkg_dir)], check=True)
    pkg_dir.rename(final)
    return final, True


def build_r_farm(farm: Path, stored: dict[str, list[tuple[str, Path]]]) -> None:
    """Link stored R packages into farm/r/{cran,bioconductor,github}.

    Each subtree is a directory of symlinks to store package directories, matching
    the three paths R_LIBS_SITE already carries. An empty subtree is NOT created, so
    the inventory does not advertise an empty R track — the same rule build_farm
    applies to conda and node.
    """
    for sub in R_SUBTREES:
        pkgs = stored.get(sub) or []
        if not pkgs:
            continue
        subdir = farm / "r" / sub
        subdir.mkdir(parents=True, exist_ok=True)
        for name, store_dir in pkgs:
            link = subdir / name
            if link.is_symlink() or link.exists():
                link.unlink()
            link.symlink_to(str(store_dir))


def r_version_of(manifest: Path) -> str | None:
    import yaml
    return (yaml.safe_load(manifest.read_text()) or {}).get("r_version")


def bioc_version() -> str | None:
    """The Bioconductor release the packages were built against, queried from R.
    Best effort — null when BiocManager is absent, since pak does not require it.
    Recorded because Bioconductor couples its release to the R version."""
    proc = subprocess.run(["Rscript", "-e", "cat(as.character(BiocManager::version()))"],
                          capture_output=True, text=True)
    return proc.stdout.strip() or None


def install_r(manifest: Path, stage_root: Path) -> None:
    """Install the manifest's R track into stage_root/r/{cran,bioconductor,github}.

    The bulk (CRAN + Bioconductor + git) reuses images/gen-r-lock.R — pak resolves it
    as one lockfile and installs it, adding each package's system libraries itself,
    and splits the result into r/cran and r/bioconductor by the CRAN-ref closure.
    GitHub installs incrementally on top (remotes::install_github, upgrade='never'),
    because it does not join the global solve. stage_root lives under the store so
    each package publishes into the store by rename, never a cross-device copy.
    """
    import yaml
    for sub in R_SUBTREES:
        (stage_root / "r" / sub).mkdir(parents=True, exist_ok=True)
    log("R bulk: resolving + installing via pak (gen-r-lock.R)")
    subprocess.run(["Rscript", "/usr/local/bin/gen-r-lock.R", str(manifest), str(stage_root)],
                   check=True)
    gh = ((yaml.safe_load(manifest.read_text()) or {}).get("r", {}) or {}).get("github", []) or []
    github_lib = stage_root / "r" / "github"
    for repo in gh:
        log(f"R github: installing {repo} (incremental, best-effort)")
        rexpr = (
            f".libPaths(c('{github_lib}', '{stage_root}/r/bioconductor', "
            f"'{stage_root}/r/cran', .libPaths())); "
            f"remotes::install_github('{repo}', lib='{github_lib}', "
            f"dependencies=TRUE, upgrade='never')"
        )
        if subprocess.run(["R", "-q", "-e", rexpr]).returncode != 0:
            log(f"WARNING: github install of {repo} did not finish cleanly; keeping what installed")


def provision_r(farm: Path, manifest: Path) -> dict:
    """Install, content-address, and farm the manifest's R track."""
    stage_root = STORE / ".staging-r"
    if stage_root.exists():
        shutil.rmtree(stage_root)
    stage_root.mkdir(parents=True)
    install_r(manifest, stage_root)

    stored: dict[str, list[tuple[str, Path]]] = {sub: [] for sub in R_SUBTREES}
    for sub in R_SUBTREES:
        libdir = stage_root / "r" / sub
        if not libdir.is_dir():
            continue
        for pkg_dir in sorted(p for p in libdir.iterdir() if (p / "DESCRIPTION").is_file()):
            name, _ = read_r_pkg(pkg_dir)
            store_dir, _is_new = store_r_package(pkg_dir)
            stored[sub].append((name, store_dir))

    build_r_farm(farm, stored)
    # TODO(task 6.6): verify each farmed R package loads — library() plus a
    # compiled-code call — against the farm's R_LIBS_SITE. The baked build does this
    # with lib-store-loadtest.R, which is currently inline in sandbox-python-r's
    # Dockerfile; wiring it here needs that helper extracted to a standalone file.
    # Keep the pak bulk lock as provenance: it records the full resolved set,
    # including the LinkingTo packages the compiled objects were built against.
    bulk_lock = stage_root / "r" / "r-bulk.lock"
    if bulk_lock.is_file():
        shutil.copy2(bulk_lock, farm / "r-bulk.lock")
    shutil.rmtree(stage_root, ignore_errors=True)

    counts = {sub: len(v) for sub, v in stored.items()}
    log(f"R farm: {counts}")
    return {"packages": counts, "r_version": r_version_of(manifest), "bioc_version": bioc_version()}


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


def reject_off_index(specs: list[str]) -> None:
    """Refuse a spec that would fetch from anywhere but the pinned index.

    A direct URL, a VCS ref, or a local path (`pkg @ https://…`, `git+https://…`,
    `./dist/pkg.whl`) bypasses the index and its hashes, so it is refused at the
    request boundary. Naming a package is allowed; naming a location is not.
    """
    off = [s for s in specs
           if "://" in s or s.strip().startswith((".", "/"))
           or s.strip().endswith((".whl", ".tar.gz", ".zip"))]
    if off:
        raise SystemExit(
            f"[provision] refusing specs that bypass the pinned index {INDEX_URL}: {off}")


def verify_store() -> int:
    """Re-hash every store directory and report any whose content drifted from its
    address. The store is write-once, so a mismatch is corruption or tampering, not a
    legitimate change."""
    if not STORE.is_dir():
        log("verify: no store")
        return 0
    checked, bad = 0, []
    for d in sorted(STORE.iterdir()):
        # Skip any dot-dir — the staging areas (.staging, .staging-r) and any other
        # bookkeeping. A published store dir is always <name>-<version>-<hash>.
        if not d.is_dir() or d.name.startswith("."):
            continue
        recorded = d.name.rsplit("-", 1)[-1]
        actual = tree_hash(d)[:16]
        checked += 1
        if actual != recorded:
            bad.append(d.name)
            log(f"  MISMATCH {d.name}: address {recorded} != content {actual}")
    log(f"verify: {checked} store dir(s) checked, {len(bad)} mismatch(es)")
    return 1 if bad else 0


def repair_staging() -> int:
    """Clear an abandoned staging tree left by an interrupted run.

    A staging directory only ever holds an install in flight: a completed publish is
    a rename OUT of it, so anything left there is debris from a run that died before
    its rename, never a published artifact. Removing it reclaims space and can never
    lose a package. The Python track stages in .staging, the R track in .staging-r.
    Safe under the single-writer assumption the per-store lock enforces; two live
    provisioners are a separate concern.
    """
    cleared = []
    for name in (".staging", ".staging-r"):
        d = STORE / name
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
            cleared.append(name)
    if cleared:
        log("repair: cleared abandoned " + ", ".join(cleared))
    else:
        log("repair: nothing to clear")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Provision packages into the library store.")
    ap.add_argument("--farm", help="analysis name (farm directory)")
    ap.add_argument("--verify", action="store_true",
                    help="re-hash every store directory, report any drift from its address, and exit")
    ap.add_argument("--repair", action="store_true",
                    help="clear an abandoned staging tree from an interrupted run, and exit")
    ap.add_argument("--warm", default="", help="comma-separated modules to import during warm-up")
    ap.add_argument("--warm-script", default=None,
                    help="path (inside the store) to a script that exercises jitted code paths")
    ap.add_argument("--r-manifest", default=None,
                    help="path to a lib-store manifest; provision its R track (CRAN + Bioconductor + git + GitHub) via pak")
    ap.add_argument("specs", nargs="*", help="requirement specs to add")
    args = ap.parse_args()

    if args.verify:
        return verify_store()
    if args.repair:
        return repair_staging()
    if not args.farm:
        log("usage: provide --farm <name> (with specs), or --verify / --repair")
        return 2
    reject_off_index(args.specs)

    STORE.mkdir(parents=True, exist_ok=True)
    FARMS.mkdir(parents=True, exist_ok=True)
    # Every run repairs before it builds: anything in store/.staging is debris from
    # an interrupted prior run (a completed publish renamed out of it).
    repair_staging()

    farm = FARMS / args.farm
    lock_path = farm / "lock.json"

    previous: list[str] = []
    if lock_path.is_file():
        previous = json.loads(lock_path.read_text()).get("requested", [])

    requested = sorted(set(previous) | set(args.specs))
    if not requested and not args.r_manifest:
        log("nothing requested and no existing lock — nothing to do")
        return 2

    resolved: dict[str, list[str]] = {}
    pins: list[str] = []
    store_dirs: list[Path] = []
    if requested:
        resolved = resolve(requested)
        pins = list(resolved)
        added = []
        for pin in pins:
            path, is_new = ensure_stored(pin, resolved[pin])
            store_dirs.append(path)
            if is_new:
                added.append(pin)
        log(f"{len(added)} newly installed, {len(pins) - len(added)} reused from store")
        shutil.rmtree(STORE / ".staging", ignore_errors=True)

    collisions = build_farm(farm, store_dirs)

    r_result: dict = {}
    if args.r_manifest:
        r_result = provision_r(farm, Path(args.r_manifest))

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
    tracks = []
    if store_dirs:
        tracks.append("python")
    if r_result.get("packages"):
        tracks.append("r")
    (farm / "meta.json").write_text(json.dumps({
        "version": args.farm,
        "arch": f"linux-{'arm64' if os.uname().machine == 'aarch64' else 'amd64'}",
        "tracks": tracks,
    }, indent=2) + "\n")

    lock_path.write_text(json.dumps({
        "requested": requested,
        "resolved": pins,
        "hashes": resolved,
        "store_dirs": [d.name for d in store_dirs],
        "r": r_result,
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
