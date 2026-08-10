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
        Its interior is the layout the sandbox image already expects:
        python/site-packages and r/{cran,bioconductor,github}. A farm carries
        packages only. The conda prefix and the Node packages belong to the image,
        at a path outside the store mount, thus a farm holds neither.

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
import contextlib
import ctypes
import errno
import fcntl
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

# One lease file per sandbox that has the store mounted. The host adds a lease when
# it starts a sandbox and drops it when the sandbox exits; the provisioner refuses to
# re-point `current` while any lease is active (see flip_current).
LEASES = LIBS / "leases"

# A farm is assembled in a staging directory beside the farms, then swapped into
# place in one atomic step (see publish_farm). Thus a stop, a refusal, or a crash
# leaves either the old complete farm or the new complete farm, and never a farm with
# links and no records. The staging and the superseded farm are dot-directories, so
# they are unreachable: `current` never selects one, and a later run reads
# `farms/<name>`. An interrupted swap is recovered by repair_staging.
FARM_STAGING = ".staging-"
FARM_SUPERSEDED = ".superseded-"

# renameat2(RENAME_EXCHANGE) swaps two existing directories in one atomic step, so
# the live farm is never absent for an instant. It is Linux-only, thus on another
# platform (the unit tests run on the host) publish_farm falls back to a two-step
# rename that repair_staging recovers.
_AT_FDCWD = -100
_RENAME_EXCHANGE = 1 << 1

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

# Marker written beside PIN_MARKER in a stored R package. It records the LinkingTo
# packages from the package's DESCRIPTION. A package that compiles against another
# package's headers stays recorded with it, so the pair stays consistent. The
# marker is excluded from the content address like the other markers.
R_LINKING_MARKER = ".inflexa-r-linking"

# Never part of a distribution's content and never farmed: `.lock` is uv's own
# per-target mutex, identical in every install, so farming it makes every package
# after the first collide on it. The two markers are metadata the provisioner
# writes, not installed content, so they stay out of the content address too.
NOT_CONTENT = {PIN_MARKER, R_LINKING_MARKER, ".lock"}

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
                or rel.parts[0] in NOT_CONTENT
                # An R store directory nests the package one level down, thus its
                # markers sit at depth two. The markers are bookkeeping, not content.
                or (len(rel.parts) == 2 and rel.parts[1] in (PIN_MARKER, R_LINKING_MARKER))):
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
    proc = subprocess.run(
        ["uv", "pip", "compile", "--python", PYTHON, "--no-header", "--quiet",
         "--generate-hashes", "--index-url", INDEX_URL, "--no-config",
         str(req), "-o", str(out)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        # Only uv knows the real cause — no route to the index, two constraints in
        # conflict, or a spec that no version satisfies — so its own message goes to
        # the user in place of a traceback.
        raise SystemExit(
            f"[provision] uv could not resolve {', '.join(specs)} against the index "
            f"{INDEX_URL} (exit {proc.returncode}). The provisioner must reach that "
            f"index.\n{proc.stderr.strip() or '(uv wrote nothing to stderr)'}")
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
        # A Python store directory carries the marker at its root. An R store
        # directory nests the package one level down, thus the marker sits inside
        # the inner directory that carries the real package name.
        for marker in (candidate / PIN_MARKER, candidate / name / PIN_MARKER):
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
    proc = subprocess.run(
        ["uv", "pip", "install", "--python", PYTHON, "--no-deps", "--no-cache",
         "--require-hashes", "--index-url", INDEX_URL, "--no-config",
         "--break-system-packages", "--target", str(staging), "-r", str(frag)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        # A refused artifact, a hash that does not match, and a build that fails all
        # arrive here as one exit code. uv's message is what separates them.
        raise SystemExit(
            f"[provision] uv could not install {pin} from the index {INDEX_URL} "
            f"(exit {proc.returncode})."
            f"\n{proc.stderr.strip() or '(uv wrote nothing to stderr)'}")

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
    # Remove only what this run makes again. This run makes the Python track again
    # when it resolves a closure, thus that subtree goes in full and no link from an
    # earlier run stays behind. A run that resolves no closure makes nothing again,
    # thus it keeps the Python track that carry_tracks_forward carried across.
    #
    # Each other entry of the farm belongs to a track this function does not build,
    # or it is a record. A removal here would undo the carry-forward, thus the R
    # track, the R inventory fragments, and r-bulk.lock stay untouched.
    #
    # The prepared caches stay as well. Each numba entry is keyed on its source
    # file, so an entry for a package this run replaced can never load, and the
    # entries for the packages that did not change stay usable.
    if store_dirs:
        stale = farm / "python"
        if stale.is_symlink():
            stale.unlink()
        elif stale.is_dir():
            shutil.rmtree(stale)
        elif stale.exists():
            stale.unlink()
    site = farm / "python" / "site-packages"
    # exist_ok, because a preserved Python track already holds this directory.
    site.mkdir(parents=True, exist_ok=True)
    # The r/ subtrees are NOT pre-created. inflexa-libs-refresh derives one
    # packages.txt section per subtree that exists, so an empty directory here would
    # advertise an empty "R (CRAN)" track to list_available_packages.

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


def _renameat2_exchange(old: Path, new: Path) -> None:
    """Atomically exchange two existing paths with renameat2(RENAME_EXCHANGE).

    The call raises OSError when the platform or the filesystem does not support the
    flag, and AttributeError when the C library has no renameat2 symbol, so
    publish_farm can fall back. Both paths must exist.
    """
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    libc.renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p,
                               ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    res = libc.renameat2(_AT_FDCWD, os.fsencode(old), _AT_FDCWD, os.fsencode(new),
                         _RENAME_EXCHANGE)
    if res != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


def publish_farm(staging: Path, farm: Path) -> None:
    """Make the fully assembled `staging` the farm at `farm`, in one atomic step.

    This is the farm-level form of the store's publish-by-rename. `staging` holds the
    complete new farm — its links AND its records — thus the swap never exposes a farm
    with links and no records.

    A first run of an analysis has no farm yet, thus a single rename publishes the
    staging to the fresh name. When the farm exists, renameat2(RENAME_EXCHANGE) swaps
    the two directories atomically: `farm` becomes the new farm and `staging` becomes
    the old one, which is then removed. On a platform or a filesystem without
    RENAME_EXCHANGE, a two-step rename does the swap, and repair_staging recovers if a
    crash lands between the two steps.
    """
    if not farm.exists():
        os.rename(staging, farm)
        return
    try:
        _renameat2_exchange(staging, farm)
    except (OSError, AttributeError):
        # No RENAME_EXCHANGE here. Move the old farm aside under a well-known name,
        # then move the new farm in. A crash between the two renames leaves the old
        # farm at FARM_SUPERSEDED and the farm missing, and repair_staging restores it.
        superseded = farm.parent / (FARM_SUPERSEDED + farm.name)
        if superseded.exists():
            shutil.rmtree(superseded)
        os.rename(farm, superseded)
        os.rename(staging, farm)
        shutil.rmtree(superseded, ignore_errors=True)
        return
    # RENAME_EXCHANGE put the old farm at the staging path; drop it.
    shutil.rmtree(staging, ignore_errors=True)


# --- Track preservation -------------------------------------------------------
# A farm carries two tracks: the Python packages and the R packages. A run builds
# the track it was asked for, and it carries the other track forward from the old
# farm. Thus an added package never removes a track, and the removal of a track
# stays an explicit operation, which is the removal of the farm.

# The entries of a farm that belong to each track. The R inventory fragments are
# not listed, because inflexa-libs-refresh derives a fragment again for each
# subtree that the staging farm holds. r-bulk.lock is the provenance of the R
# track, thus it travels with the track.
TRACK_ENTRIES: dict[str, tuple[str, ...]] = {
    "python": ("python",),
    "r": ("r", "r-bulk.lock"),
}


def carry_tracks_forward(farm: Path, staging: Path, builds: set[str]) -> list[str]:
    """Carry each track that the run does not build into the staging farm.

    A track of a farm is a tree of symbolic links into the content-addressed store,
    and the copy keeps each link verbatim. Thus the carry-forward installs no
    package and it opens no network connection, and the published farm resolves the
    preserved track through the same paths as before.

    The copy reads the old farm and it writes the staging farm. It never removes an
    entry from the old farm, thus a stop or a crash before the swap leaves the farm
    path with one complete farm. A move would be cheaper by one link write, but a
    move that is not followed by a publish loses the track.
    """
    preserved: list[str] = []
    for track, entries in sorted(TRACK_ENTRIES.items()):
        if track in builds:
            continue
        carried = False
        for entry in entries:
            src = farm / entry
            if src.is_dir() and not src.is_symlink():
                # symlinks=True keeps each link as a link. As a result the copy
                # reads no package byte, and it cannot follow a link into the store.
                shutil.copytree(src, staging / entry, symlinks=True)
                carried = True
            elif src.is_file():
                shutil.copy2(src, staging / entry)
                carried = True
        if carried:
            preserved.append(track)
    return preserved


def farm_tracks(farm: Path) -> list[str]:
    """The tracks that a farm carries, read from the farm itself.

    The record of a run alone reports a `python` track for a farm that also carries
    `r`. The inventory of a farm states what a sandbox can import, thus the record
    must describe the farm as published and not the work of the run.
    """
    tracks: list[str] = []
    site = farm / "python" / "site-packages"
    if site.is_dir() and any(site.iterdir()):
        tracks.append("python")
    if any((farm / "r" / sub).is_dir() for sub in R_SUBTREES):
        tracks.append("r")
    return tracks


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


def read_r_linking(pkg_dir: Path) -> list[str]:
    """Bare names of the LinkingTo packages of an installed R package.

    A package that compiles against another package's headers names it in the
    LinkingTo field of DESCRIPTION. The field is a comma-separated list, and a long
    list continues on each indented line. An entry can carry a version constraint in
    parentheses, and this function removes it to keep the bare name.
    """
    lines = (pkg_dir / "DESCRIPTION").read_text(errors="replace").splitlines()
    value: str | None = None
    for index, line in enumerate(lines):
        if line.startswith("LinkingTo:"):
            value = line.split(":", 1)[1]
            # A DESCRIPTION field continues on each following indented line.
            for cont in lines[index + 1:]:
                if cont[:1] in (" ", "\t"):
                    value += " " + cont.strip()
                else:
                    break
            break
    if not value:
        return []
    names = []
    for entry in value.split(","):
        name = entry.split("(", 1)[0].strip()
        if name:
            names.append(name)
    return names


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
    # Nest the package inside the store directory, under its real package name.
    # R passes a loaded package its resolved library path, and a package such as
    # Rfast rebuilds its own path as `libname/packagename` in `.onAttach`. A flat
    # store directory resolves that to `store/<name>`, which does not exist. With
    # the nesting, the resolved library path is the store directory, and
    # `libname/packagename` lands on the inner directory. renv's cache proves the
    # layout. The wrapper is hashed, thus `verify` re-hashes the same shape.
    wrap = pkg_dir.parent / f".wrap-{pkg_dir.name}"
    if wrap.exists():
        shutil.rmtree(wrap)
    wrap.mkdir()
    pkg_dir.rename(wrap / name)
    inner = wrap / name
    digest = tree_hash(wrap)[:16]   # no PIN_MARKER yet; tree_hash excludes it regardless
    final = STORE / f"{canon(name)}-{version}-{digest}"
    if final.exists():
        shutil.rmtree(wrap)
        return final, False
    (inner / PIN_MARKER).write_text(pin + "\n")
    # Record the LinkingTo packages beside the pin, so a package built against
    # another package's headers stays recorded with it.
    (inner / R_LINKING_MARKER).write_text(json.dumps(read_r_linking(inner)) + "\n")
    subprocess.run(["chmod", "-R", "a+rX", str(wrap)], check=True)
    wrap.rename(final)
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
            # The target is the inner directory, whose basename is the real package
            # name. Thus a package that rebuilds its path as libname/packagename
            # resolves itself through the realpath of the link.
            link.symlink_to(str(store_dir / name))


def check_r_loads(farm: Path, stored: dict[str, list[tuple[str, Path]]]) -> None:
    """Load each farmed R package through the farm, and run its compiled code.

    A package can install and farm cleanly and still fail to load, because the farm
    resolves it through symlinks and a compiled package finds its shared object by
    the path R gives it. The check sets the same three R_LIBS_SITE paths the sandbox
    uses, then runs library() on each farmed package. For a package that carries
    compiled code, it also reads the registered native routines, which runs the
    package's own compiled code. A package that does not load names itself and stops
    the run, because a farm that cannot load is not usable.
    """
    lib_dirs = [farm / "r" / sub for sub in R_SUBTREES if (farm / "r" / sub).is_dir()]
    packages = [(name, store_dir)
                for sub in R_SUBTREES for name, store_dir in stored.get(sub, [])]
    if not packages:
        return
    libs_expr = ", ".join(f"'{d}'" for d in lib_dirs)
    for name, store_dir in packages:
        # A compiled package keeps its shared object under libs/. Load it, then read
        # its registered routines, so the check runs the compiled code and not only
        # the symlink resolution.
        if (store_dir / name / "libs").is_dir():
            probe = (f"d <- getLoadedDLLs()[['{name}']]; "
                     f"if (!is.null(d)) invisible(getDLLRegisteredRoutines(d)); ")
        else:
            probe = ""
        rexpr = (f".libPaths(c({libs_expr}, .libPaths())); "
                 f"suppressMessages(library('{name}', character.only = TRUE)); {probe}")
        proc = subprocess.run(["Rscript", "-e", rexpr], capture_output=True, text=True)
        if proc.returncode != 0:
            # The last line of an R failure is usually the bare "Execution halted".
            # The cause sits in the lines above it, thus the report carries the tail
            # of the stream and not one line.
            tail = (proc.stderr or "").strip().splitlines()[-8:]
            detail = "\n  ".join(tail) if tail else "(R wrote nothing to stderr)"
            raise SystemExit(
                f"[provision] R package {name} does not load through the farm "
                f"(exit {proc.returncode}):\n  {detail}")
    log(f"R load check: {len(packages)} package(s) load through the farm")


def r_version_of(manifest: Path) -> str | None:
    import yaml
    return (yaml.safe_load(manifest.read_text()) or {}).get("r_version")


# Bioconductor serves every artifact of a release under `.../packages/<release>/`, and
# a release is always two numbers. The number shape is what separates a release from
# the package name in a git URL such as `https://git.bioconductor.org/packages/DEP`.
BIOC_RELEASE_IN_URL = re.compile(r"https?://[^/]*bioconductor[^/]*/packages/(\d+\.\d+)(?:/|$)")


def bioc_releases(lock_path: Path) -> list[str]:
    """The Bioconductor releases that a pak lock file names, sorted and with no duplicate.

    The lock holds the source URL of each package. Thus the lock is the true record of
    the releases in a farm. BiocManager can also name a release, but it reads a static
    map of the R version in use. That map is a claim about a table, not a fact about
    the packages on disk, and the two disagree as soon as one package comes from a
    frozen release. A farm can hold more than one release at the same time, thus the
    value is a list and not one string.

    A git-pinned Bioconductor package carries a commit, not a release, so its lock
    entry has no release to read. This function skips it.

    An absent or damaged lock gives an empty list, because a Python-only run writes no
    lock and a lock entry can lack `sources` or `metadata`.
    """
    try:
        lock = json.loads(Path(lock_path).read_text())
    except (OSError, ValueError):
        return []
    packages = lock.get("packages") if isinstance(lock, dict) else None
    if not isinstance(packages, list):
        return []
    found: set[str] = set()
    for pkg in packages:
        if not isinstance(pkg, dict):
            continue
        # pak writes the release into the artifact URL and into RemoteRepos. Read both
        # and keep whatever parses, because either one alone can be absent.
        urls = pkg.get("sources")
        candidates = list(urls) if isinstance(urls, list) else []
        metadata = pkg.get("metadata")
        if isinstance(metadata, dict):
            candidates.append(metadata.get("RemoteRepos"))
        for candidate in candidates:
            if isinstance(candidate, str):
                found.update(BIOC_RELEASE_IN_URL.findall(candidate))
    # Sort on the numbers, because release 3.9 comes before release 3.23 but sorts
    # after it as text.
    return sorted(found, key=lambda release: tuple(int(part) for part in release.split(".")))


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
    # A farmed package can install cleanly and still fail to load. Load each one
    # through the farm before the run reports success.
    check_r_loads(farm, stored)
    # Keep the pak bulk lock as provenance: it records the full resolved set,
    # including the LinkingTo packages the compiled objects were built against.
    bulk_lock = stage_root / "r" / "r-bulk.lock"
    releases: list[str] = []
    if bulk_lock.is_file():
        # Read the releases here, because the lock still exists at this point. The
        # step below removes the staging tree that holds it.
        releases = bioc_releases(bulk_lock)
        shutil.copy2(bulk_lock, farm / "r-bulk.lock")
    shutil.rmtree(stage_root, ignore_errors=True)

    counts = {sub: len(v) for sub, v in stored.items()}
    log(f"R farm: {counts}, Bioconductor release(s): {releases or 'none'}")
    return {"packages": counts, "r_version": r_version_of(manifest), "bioc_releases": releases}


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
    """Clear an abandoned staging tree, and recover an interrupted farm swap.

    A store staging directory only ever holds an install in flight: a completed
    publish is a rename OUT of it, so anything left there is debris from a run that
    died before its rename, never a published artifact. Removing it reclaims space and
    can never lose a package. The Python track stages in store/.staging, the R track
    in store/.staging-r.

    A farm swap can also stop in the middle. publish_farm assembles the new farm in
    farms/.staging-<name> and, on a platform without RENAME_EXCHANGE, moves the old
    farm to farms/.superseded-<name> for one instant. This step recovers both: it
    restores the old farm when a crash left the farm missing, and it removes any
    leftover staging or superseded farm. Thus the reachable farm is always the old
    complete farm or the new complete farm, never a half-built tree.

    Safe under the single-writer assumption the per-store lock enforces; two live
    provisioners are a separate concern.
    """
    cleared = []
    for name in (".staging", ".staging-r"):
        d = STORE / name
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
            cleared.append(f"store/{name}")

    if FARMS.is_dir():
        # Recover an interrupted swap first. A superseded farm means publish_farm
        # moved the old farm aside. If the farm is now missing, the swap died between
        # the two renames, so restore the old farm. Otherwise the new farm is already
        # in place and the superseded copy is only debris.
        for sup in sorted(FARMS.glob(FARM_SUPERSEDED + "*")):
            farm_name = sup.name[len(FARM_SUPERSEDED):]
            farm = FARMS / farm_name
            if farm.exists():
                shutil.rmtree(sup, ignore_errors=True)
                cleared.append(f"farms/{sup.name}")
            else:
                stg = FARMS / (FARM_STAGING + farm_name)
                if stg.exists():
                    shutil.rmtree(stg, ignore_errors=True)
                os.rename(sup, farm)
                cleared.append(f"farms/{sup.name} (restored {farm_name})")
        # Any staging farm left now is an un-published build, or the old farm that a
        # completed RENAME_EXCHANGE left behind. Neither is the reachable farm.
        for stg in sorted(FARMS.glob(FARM_STAGING + "*")):
            shutil.rmtree(stg, ignore_errors=True)
            cleared.append(f"farms/{stg.name}")

    if cleared:
        log("repair: cleared abandoned " + ", ".join(cleared))
    else:
        log("repair: nothing to clear")
    return 0


@contextlib.contextmanager
def store_lock():
    """Hold an exclusive per-store lock for the length of a mutating run.

    Content addressing makes the package writes race-safe, but the `current` pointer
    and farm assembly are not, so a whole provisioning (or reclaim) run holds this.
    Non-blocking: a second run reports the conflict rather than queueing behind a
    build of unknown length. Closing the fd releases the flock, including on crash.
    """
    LIBS.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(LIBS / ".provision.lock"), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise SystemExit("[provision] another provisioning run holds the store lock; retry when it finishes")
        yield
    finally:
        os.close(fd)


def active_leases() -> list[str]:
    """Ids of sandboxes the host has recorded as holding the store mounted."""
    if not LEASES.is_dir():
        return []
    return sorted(p.name for p in LEASES.iterdir() if p.is_file())


def add_lease(lease_id: str) -> int:
    LEASES.mkdir(parents=True, exist_ok=True)
    (LEASES / lease_id).write_text(lease_id + "\n")
    log(f"lease added: {lease_id}")
    return 0


def drop_lease(lease_id: str) -> int:
    p = LEASES / lease_id
    if p.exists():
        p.unlink()
        log(f"lease dropped: {lease_id}")
    else:
        log(f"lease not found: {lease_id}")
    return 0


def flip_current(farm_name: str, force: bool = False) -> None:
    """Point `current` at farm_name, refusing to move it under a live sandbox.

    Re-pointing the symlink breaks a container that has the store mounted — measured,
    its /mnt/libs/current raises FileNotFoundError from then on — so a re-point is an
    operation BETWEEN sandboxes. Re-pointing to the SAME target is a no-op: adding to
    a farm `current` already selects is safe, because existing links are untouched.
    The host clears the lease once it confirms no sandbox is mounted; --force-repoint
    is the escape hatch for a stale lease.
    """
    current = LIBS / "current"
    target = f"farms/{farm_name}"
    if current.is_symlink() and os.readlink(current) == target:
        return
    leases = active_leases()
    if leases and not force:
        raise SystemExit(
            f"[provision] refusing to re-point current to {farm_name}: "
            f"{len(leases)} sandbox lease(s) active ({', '.join(leases[:5])}). "
            f"A live sandbox resolves /mnt/libs/current; re-pointing breaks it.")
    if current.is_symlink() or current.exists():
        current.unlink()
    current.symlink_to(target)


def _referenced_store_dirs() -> set[str]:
    """Store directory names any farm currently links to."""
    referenced: set[str] = set()
    if not FARMS.is_dir():
        return referenced
    for farm in FARMS.iterdir():
        # A dot-directory is a staging or a superseded farm from an interrupted swap,
        # not a real farm. Skipping it keeps its transient links from holding a store
        # directory that reclaim could otherwise remove.
        if not farm.is_dir() or farm.name.startswith("."):
            continue
        for link in farm.rglob("*"):
            if link.is_symlink():
                tgt = os.readlink(link)
                if "/store/" in tgt:
                    referenced.add(tgt.split("/store/", 1)[1].split("/", 1)[0])
    return referenced


def reclaim() -> int:
    """Remove store directories no farm references.

    A package no current farm uses is still kept until this runs, so an old analysis
    can be rebuilt — reclamation is explicit and host-invoked, never automatic. This
    is a harness operation; the user-facing command belongs to the CLI.
    """
    if not STORE.is_dir():
        log("reclaim: no store")
        return 0
    referenced = _referenced_store_dirs()
    removed = 0
    for d in sorted(STORE.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        if d.name not in referenced:
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
            log(f"  reclaimed {d.name}")
    log(f"reclaim: {removed} unreferenced store dir(s) removed, {len(referenced)} still referenced")
    return 0


def remove_farm(farm_name: str) -> int:
    """Remove a farm — the set of symlinks for one analysis. The store dirs it
    referenced stay until reclaim runs. Refuses the farm `current` selects, since
    that is the live one a sandbox may be reading."""
    farm = FARMS / farm_name
    if not farm.is_dir():
        log(f"remove-farm: no such farm {farm_name}")
        return 2
    current = LIBS / "current"
    if current.is_symlink() and os.readlink(current) == f"farms/{farm_name}":
        raise SystemExit(f"[provision] refusing to remove farm {farm_name}: current points at it")
    shutil.rmtree(farm, ignore_errors=True)
    log(f"removed farm {farm_name} (run --reclaim to drop store dirs it alone referenced)")
    return 0


def _provision(args) -> int:
    STORE.mkdir(parents=True, exist_ok=True)
    FARMS.mkdir(parents=True, exist_ok=True)
    # Every run repairs before it builds: anything in a staging dir is debris from an
    # interrupted prior run (a completed publish renamed out of it).
    repair_staging()

    farm = FARMS / args.farm
    staging = FARMS / (FARM_STAGING + args.farm)
    lock_path = farm / "lock.json"

    old_lock: dict = {}
    if lock_path.is_file():
        old_lock = json.loads(lock_path.read_text())
    previous: list[str] = old_lock.get("requested", [])

    requested = sorted(set(previous) | set(args.specs))
    if not requested and not args.r_manifest:
        log("nothing requested and no existing lock — nothing to do")
        return 2

    # The tracks this run builds. A track that is absent here is carried forward
    # from the old farm below, thus a run that adds a Python package keeps the R
    # track that it does not build.
    builds: set[str] = set()
    if requested:
        builds.add("python")
    if args.r_manifest:
        builds.add("r")

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

    # Assemble the whole new farm in a staging directory beside the farms, never in
    # `farm` itself. The live farm stays untouched until the atomic swap below, thus a
    # stop, a refusal, or a crash before the swap leaves the old farm intact, and the
    # half-built farm stays at the unreachable staging path.
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)

    # Carry the prepared caches forward from the old farm. Each numba entry is keyed on
    # its source file path, so an entry for a package this run does not change still
    # loads, and a fresh farm would force the sandbox to recompile it. A cache holds
    # real files, thus it moves rather than copies. Cache preservation is an
    # optimization, thus a move that fails is logged, never fatal, and the cache
    # rebuilds on the next warm.
    for cache in ("numba-cache", "matplotlib_config"):
        src = farm / cache
        if src.is_dir():
            try:
                os.rename(src, staging / cache)
            except OSError as exc:
                log(f"  note: could not carry {cache} forward ({exc}); it rebuilds on the next warm")

    # Carry each track that this run does not build. The order matters: build_farm
    # writes into a staging farm that already holds the preserved trees, thus a run
    # that adds a Python package publishes a farm with both tracks.
    preserved = carry_tracks_forward(farm, staging, builds)
    log(f"tracks: this run builds {', '.join(sorted(builds)) or 'none'}; "
        f"preserved from the old farm: {', '.join(preserved) or 'none'}")

    collisions = build_farm(staging, store_dirs)

    # A run that does not build R preserves the R track, thus the lock must still
    # describe the R closure that the farm inherited. Carry the r block of the old
    # lock forward. Otherwise r_result is {}, and the record drops the preserved R
    # closure that the farm still resolves.
    r_result: dict = old_lock.get("r", {})
    if args.r_manifest:
        r_result = provision_r(staging, Path(args.r_manifest))

    # The warm workload is what the caches hold, so record it before the lock is
    # written. Read the script bytes once and keep their hash, because a path can
    # later point at a different file, and a replay must run the same bytes.
    warm_targets = [m for m in args.warm.split(",") if m]
    warm_script_hash = None
    if args.warm_script:
        with contextlib.suppress(OSError):
            warm_script_hash = hashlib.sha256(Path(args.warm_script).read_bytes()).hexdigest()

    lock = {
        "requested": requested,
        "resolved": pins,
        "hashes": resolved,
        "store_dirs": [d.name for d in store_dirs],
        "r": r_result,
        # Which track this run built, and which track it inherited from the old
        # farm. A later run reads this to tell a rebuilt track from a preserved one.
        "tracks": {"built": sorted(builds), "preserved": preserved},
        "collisions": collisions,
        # The path of the warm script, kept so the effectiveness check can run it.
        "warm_script": args.warm_script,
        # The workload the warm step ran, recorded so the effectiveness check can
        # replay exactly it. numba keys its cache per type signature, thus only the
        # call shapes the workload ran are cached, and any other shape recompiles.
        # The module list and a content hash of the script let a replay confirm the
        # same bytes ran, not merely a file at the same path.
        "warm_workload": {
            "modules": warm_targets,
            "script_sha256": warm_script_hash,
        },
        "warm": {},
    }

    def write_lock(dest: Path) -> None:
        (dest / "lock.json").write_text(json.dumps(lock, indent=2) + "\n")

    # The records go into the staging farm, thus the farm the swap publishes already
    # holds every marker the harness needs. The same producer the images use writes
    # packages.txt, so it is byte-identical in shape to what list_available_packages
    # already parses.
    subprocess.run(["/usr/local/bin/inflexa-libs-refresh", "--rederive"],
                   env={**os.environ, "INFLEXA_LIB_ROOT": str(staging)}, check=True)

    # Second of the two completeness markers libStoreUsable requires before it
    # will bind the store; without it the mount is silently dropped. The track list
    # comes from the staging farm as it publishes, thus it names each preserved
    # track beside each rebuilt one.
    tracks = farm_tracks(staging)
    (staging / "meta.json").write_text(json.dumps({
        "version": args.farm,
        "arch": f"linux-{'arm64' if os.uname().machine == 'aarch64' else 'amd64'}",
        "tracks": tracks,
    }, indent=2) + "\n")

    write_lock(staging)
    # The mode goes with the records, because the sandbox reads the farm as a
    # different uid the moment `current` selects it.
    subprocess.run(["chmod", "-R", "a+rX", str(staging)], check=True)

    # The staging farm is complete. Swap it into place in one atomic step, thus the
    # farm is never a half-built tree that the harness could mount or a later run could
    # read. From here on `farm` is the new complete farm.
    publish_farm(staging, farm)

    # Flip `current` AFTER the swap, so a refusal leaves the new complete farm in place
    # and `current` unchanged. flip_current refuses under a live sandbox lease, which
    # is a designed outcome and costs the farm nothing. Flipping before warming makes
    # the warm-up run against the exact path the sandbox will import from (see warm()).
    flip_current(args.farm, force=args.force_repoint)

    if warm_targets or args.warm_script:
        lock["warm"] = warm(farm, warm_targets, args.warm_script)
        # The lock is the record of what the caches hold, so the warm results go into
        # it, and the caches the warm wrote get the mode the sandbox needs.
        write_lock(farm)
        subprocess.run(["chmod", "-R", "a+rX", str(farm)], check=True)

    log(f"farm '{args.farm}' ready: {len(pins)} distributions")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Provision packages into the library store.")
    ap.add_argument("--farm", help="analysis name (farm directory)")
    ap.add_argument("--verify", action="store_true",
                    help="re-hash every store directory, report any drift from its address, and exit")
    ap.add_argument("--repair", action="store_true",
                    help="clear an abandoned staging tree from an interrupted run, and exit")
    ap.add_argument("--reclaim", action="store_true",
                    help="remove store directories no farm references, and exit")
    ap.add_argument("--add-lease", default=None, metavar="ID",
                    help="record that a sandbox holds the store mounted (blocks re-pointing current)")
    ap.add_argument("--drop-lease", default=None, metavar="ID",
                    help="clear a sandbox's mount lease")
    ap.add_argument("--remove-farm", default=None, metavar="NAME",
                    help="remove a farm's symlinks (store dirs stay until --reclaim), and exit")
    ap.add_argument("--force-repoint", action="store_true",
                    help="re-point current even with active leases (host must confirm no sandbox is mounted)")
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
    if args.reclaim:
        with store_lock():
            return reclaim()
    if args.add_lease:
        return add_lease(args.add_lease)
    if args.drop_lease:
        return drop_lease(args.drop_lease)
    if args.remove_farm:
        with store_lock():
            return remove_farm(args.remove_farm)
    if not args.farm:
        log("usage: --farm <name> (with specs / --r-manifest), or --verify / --repair / "
            "--reclaim / --add-lease ID / --drop-lease ID / --remove-farm NAME")
        return 2
    reject_off_index(args.specs)

    with store_lock():
        return _provision(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except OSError as exc:
        # A filesystem error — no space, a read-only store, a permission — reaches
        # here as a clean message and a non-zero exit, in place of a traceback. This
        # is the same contract resolve() and ensure_stored() hold for a failed tool.
        # The staging farm that the run left behind is unreachable, and the next run
        # repairs it, so the farm the harness sees stays complete.
        name = errno.errorcode.get(exc.errno, "?") if exc.errno else "?"
        where = f": {exc.filename}" if exc.filename else ""
        sys.exit(f"[provision] a filesystem error stopped the run: "
                 f"{exc.strerror or exc} ({name}){where}")
