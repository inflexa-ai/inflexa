#!/usr/bin/env python3
"""Turn package requests into files on disk. Runs inside the provisioner.

The provisioner is the only container with network access and the only one with
a compiler. It mounts the package store and nothing else, thus there is no user
data here to leak to the network that it can reach.

One host directory, three roles, under the path that the harness knows as
`libStorePath` and bind-mounts read-only at /mnt/libs:

  /mnt/libs/store/<name>-<version>-<hash16>/
        Content-addressed, write-once, one directory per installed
        distribution. Ten analyses that use scanpy share one copy.

  /mnt/libs/farms/<analysis>/
        One symlink farm per analysis — its dependency closure and nothing
        else. Its interior is the layout that the sandbox expects:
        python/site-packages and r/{cran,bioconductor,github}. A farm carries
        packages only. The conda prefix and the Node packages belong to the
        image, at a path outside the store mount.

  /mnt/libs/deps.json
        The dependency graph of the store, one node for each store directory
        and each edge resolved. emit_deps.py writes it.

The store carries NO `current` pointer and NO lease files. A sandbox receives
its own farm as a second read-only bind at /mnt/libs/farm, nested inside the
store-root bind, and the invoker of the container adds that bind. Thus two
analyses resolve two farms at the same time.

The entrypoint has six subcommands, one mode each. An impossible combination
is impossible by structure, because argparse accepts one subcommand:

  build          — the store build workflow. It resolves the manifest, builds the
                   catalog farm, writes its `inflexa.lock` last, and publishes the
                   farm by a crash-atomic staging swap.
  acquire        — the acquisition flights of the host. It installs a spec set
                   into the pool, and it stages the graph nodes for the host
                   commit. It writes no farm and it never touches deps.json.
  acquire-source — the source-build flight of the host. It runs the approved
                   build script over a pristine source snapshot, writes the root
                   artifact into the pool, stages the graph nodes for the host
                   commit, and writes the build record beside the pin marker.
  prepare        — the store build workflow. It runs the warm script of each
                   manifest entry that names one, against the catalog farm, and
                   it records the cache entries per package in the farm lock.
  reclaim        — the host reclamation command. It removes the store
                   directories that no farm links and the graph does not
                   advertise, under the exclusive lock.
  remove-farm    — the analysis delete flow of the host. It removes one farm and
                   never touches the pool.

Repair of abandoned staging debris runs as an internal step at the start of
each run, never as a subcommand. Refer to store_lock().

That /mnt/libs is mounted at the SAME path here (read-write) and in the
sandbox (read-only) is the load-bearing detail. It is what makes a farm
symlink written here resolve there, and it is why cache warm-up can run here
at all: numba's cache key holds the source path that the sandbox imports from.
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
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import emit_deps
from package_identity import (TRACKS, PackageQuery, QueryError, address,
                              identity_of, key, parse_query, python_identity,
                              r_identity)

LIBS = Path(os.environ.get("LIB_ROOT", "/mnt/libs"))
STORE = LIBS / "store"
FARMS = LIBS / "farms"

# The path the sandbox mounts the store at, read-only. The provisioner must see
# the store at this SAME path — the load-bearing detail — because a farm's
# links bake it as an absolute target that the sandbox has to resolve.
SANDBOX_MOUNT = Path(os.environ.get("SANDBOX_LIB_MOUNT", "/mnt/libs"))

# The container path of the farm under the published images. A preparation run
# needs the catalog farm bound here, because a numba cache key holds the source
# path that the sandbox imports from.
FARM_BIND = LIBS / "farm"

# A farm is assembled in a staging directory beside the farms, then swapped
# into place in one atomic step (refer to publish_farm). Thus a stop, a
# refusal, or a crash leaves either the old complete farm or the new complete
# farm, and never a farm with links and no lock. The staging and the
# superseded farm are dot-directories, thus they are unreachable.
FARM_STAGING = ".staging-"
FARM_SUPERSEDED = ".superseded-"

# renameat2(RENAME_EXCHANGE) swaps two existing directories in one atomic
# step, thus the live farm is never absent for an instant. It is Linux-only,
# thus on another platform (the unit tests run on the host) publish_farm falls
# back to a two-step rename that the repair step recovers.
_AT_FDCWD = -100
_RENAME_EXCHANGE = 1 << 1

# The sandbox runs the system interpreter, thus resolution and the compiled
# extension suffixes pin to it, not to whatever uv would pick.
PYTHON = "/usr/bin/python3"

# The one Python index the provisioner can resolve and download from. Every
# install runs under `--require-hashes`, thus a substituted artifact fails its
# hash check rather than installing. The egress allowlist of the image is the
# network half of the same boundary; this is the resolver half.
INDEX_URL = os.environ.get("INFLEXA_INDEX_URL", "https://pypi.org/simple")
# The session exec carries its own shorter budget in the normal path. This
# bound exists for a direct run of the subcommand, so a wedged build ends as a
# clean refusal instead of a hung process.
BUILD_SCRIPT_TIMEOUT_SECONDS = 3600

# The bound on the KILL sweep of the build user after the script returns. The
# sweep signals processes and returns at once, thus a wait past this bound
# means a wedged exec, not slow work.
BUILD_KILL_TIMEOUT_SECONDS = 30

# The build script runs as the `inflexa-build` user of the image. uid 1000 is
# also the uid of the sandbox workload, which is why the session proves the
# script under it.
BUILD_UID = 1000
BUILD_GID = 1000
BUILD_HOME = "/home/inflexa-build"

# A Debian package name: at least two characters, a lowercase letter or a digit
# first. A value that starts with `-` never reaches apt-get as an option.
APT_PACKAGE_NAME = re.compile(r"[a-z0-9][a-z0-9+.-]+")

# How much of the script output a refusal reads back, in bytes from the end.
OUTPUT_TAIL_BYTES = 8192

# Marker written inside each store directory: the exact pin it was installed
# from, thus a name+version glob can be confirmed rather than trusted.
PIN_MARKER = ".inflexa-pin"

# Marker beside PIN_MARKER: the full sha256 of the sorted tree, taken at store
# time. The farm lock carries the full hash of each package, and this marker
# saves a re-hash of the whole pool at each farm build.
HASH_MARKER = ".inflexa-hash"

# Marker beside PIN_MARKER in a stored R package: the LinkingTo packages from
# its DESCRIPTION, recorded as build metadata. LinkingTo gives no graph edge.
R_LINKING_MARKER = ".inflexa-r-linking"

# Marker beside PIN_MARKER of a source-built root: the build record. A source
# build carries no index hash — no index served it — thus the script and this
# record are its provenance, and like the other markers the record stays out of
# the content address and out of every farm link.
BUILD_MARKER = ".inflexa-build.json"

# Never part of a distribution's content and never farmed: `.lock` is uv's own
# per-target mutex. The markers are provisioner metadata, not installed
# content, thus they stay out of the content address too.
NOT_CONTENT = {PIN_MARKER, HASH_MARKER, R_LINKING_MARKER, BUILD_MARKER, ".lock"}

# Derived data that must not participate in the content address: warm-up
# writes numba artifacts and CPython bytecode into the tree AFTER the hash is
# taken, and an address that moved underneath them would defeat all reuse.
HASH_EXCLUDE_DIRS = {"__pycache__"}
HASH_EXCLUDE_SUFFIX = (".pyc", ".nbi", ".nbc")

# Acquisition runs are parallel, thus each run stages its installs under a
# name of its own. Outside a run the token is empty.
RUN_TOKEN = ""


def log(msg: str) -> None:
    print(f"[provision] {msg}", flush=True)


def arch() -> str:
    return "arm64" if os.uname().machine == "aarch64" else "amd64"


# --- The content address --------------------------------------------------


def tree_hash(root: Path) -> str:
    """Content address of an installed distribution.

    Covers the relative path, the file bytes, the executable bit, and each
    symlink target — everything that changes what the sandbox loads.
    """
    h = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda p: str(p.relative_to(root))):
        rel = path.relative_to(root)
        if (HASH_EXCLUDE_DIRS & set(rel.parts) or path.name.endswith(HASH_EXCLUDE_SUFFIX)
                or rel.parts[0] in NOT_CONTENT
                # An R store directory nests the package one level down, thus
                # its markers sit at depth two.
                or (len(rel.parts) == 2 and rel.parts[1] in NOT_CONTENT)):
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


def stored_full_hash(store_dir: Path) -> str:
    """The full sha256 of one store directory, from its marker.

    The marker writes at store time. A directory without one (never expected
    after this rebuild) re-hashes, thus the lock never carries an empty hash.
    """
    for marker in (store_dir / HASH_MARKER, *(inner / HASH_MARKER for inner in store_dir.iterdir() if inner.is_dir())):
        if marker.is_file():
            return marker.read_text().strip()
    return tree_hash(store_dir)


# --- Resolution and the pool ------------------------------------------------


def run_temp(name: str) -> Path:
    """A temporary path of this run, under /tmp, keyed by the run token."""
    return Path("/tmp") / (f"{RUN_TOKEN}-{name}" if RUN_TOKEN else name)


def staging_dir(track: str) -> Path:
    """The private staging directory of this run for `track`."""
    name = ".staging" if track == "python" else f".staging-{track}"
    return STORE / (f"{name}-{RUN_TOKEN}" if RUN_TOKEN else name)


def resolve(specs: list[str], constraints: Path | None = None) -> dict[str, list[str]]:
    """Full dependency closure of `specs`, as pinned name==version -> hashes.

    `--generate-hashes` records a hash for every resolved artifact, and the
    install step enforces it with `--require-hashes`. Resolution runs against
    the pinned index only, with `--no-config` so no ambient configuration can
    add another. A resolved requirement that carries a URL fails the resolve.
    `constraints` pins the resolution to the committed lock where the manifest
    still matches — the `npm install` model.
    """
    req = run_temp("requirements.in")
    req.write_text("\n".join(specs) + "\n")
    out = run_temp("requirements.txt")
    log(f"resolving closure of: {', '.join(specs)}")
    cmd = ["uv", "pip", "compile", "--python", PYTHON, "--no-header", "--quiet",
           "--generate-hashes", "--index-url", INDEX_URL, "--no-config"]
    if constraints is not None:
        cmd += ["--constraint", str(constraints)]
    proc = subprocess.run([*cmd, str(req), "-o", str(out)], capture_output=True, text=True)
    if proc.returncode != 0:
        # Only uv knows the real cause — no route to the index, two
        # constraints in conflict, or a spec that no version satisfies.
        raise ResolveError(
            f"uv could not resolve {', '.join(specs)} against the index "
            f"{INDEX_URL} (exit {proc.returncode}).\n"
            f"{proc.stderr.strip() or '(uv wrote nothing to stderr)'}")
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
        if "://" in line:
            raise ResolveError(f"resolved artifact from an unexpected host: {line!r}")
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


class ResolveError(Exception):
    """A spec set that the resolver refused. An acquire run catches it per
    spec, thus one bad spec drops out with its own refusal and the rest of the
    batch still lands. A build run lets it stop the run."""


def find_stored(pin: str, track: str) -> Path | None:
    """An existing store directory that holds exactly this pin.
    The directory carries the ADDRESS of the identity, not its name: `GO.db`
    stores under `go-db-<version>-<hash16>`. The pin marker inside carries the
    identity, thus two identities of one address stay apart.

    A source pin carries a qualifier (`name==version@git:<sha>` or
    `name==version@tree:<sha16>`), and the DIRECTORY keeps the bare version,
    because the graph node reads its version from the directory name. The glob
    therefore strips the qualifier, and the marker match requires the full pin
    text: an index pin never matches a source build, a source pin never matches
    an index build, and a repeat source build of one qualified pin reuses its
    own directory.
    """
    name, version = pin.split("==", 1)
    bare = version.split("@", 1)[0]
    for candidate in sorted(STORE.glob(f"{address(identity_of(track, name))}-{bare}-*")):
        for marker in (candidate / PIN_MARKER, candidate / name / PIN_MARKER):
            if marker.is_file() and marker.read_text().strip() == pin:
                return candidate
    return None


def ensure_stored(pin: str, hashes: list[str]) -> tuple[Path, bool]:
    """The store directory for `pin`, installed when absent.

    The install runs under `--require-hashes`: uv refuses an artifact whose
    download matches none of the recorded hashes. A pin that reaches here
    without a hash fails loudly rather than installing unverified.
    """
    existing = find_stored(pin, "python")
    if existing is not None:
        return existing, False

    name, version = pin.split("==", 1)
    identity = python_identity(name)
    if not hashes:
        raise SystemExit(f"[provision] refusing to install {pin} without a source hash")
    # Staged inside the store, not under /tmp: publishing is a rename, and a
    # rename is atomic within one filesystem only.
    staging = staging_dir("python") / address(identity)
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)

    frag = run_temp(f"req-{address(identity)}.txt")
    frag.write_text(pin + "".join(f" --hash={h}" for h in hashes) + "\n")

    log(f"installing {pin}")
    proc = subprocess.run(
        ["uv", "pip", "install", "--python", PYTHON, "--no-deps", "--no-cache",
         "--require-hashes", "--index-url", INDEX_URL, "--no-config",
         "--break-system-packages", "--target", str(staging), "-r", str(frag)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise ResolveError(
            f"uv could not install {pin} from the index {INDEX_URL} "
            f"(exit {proc.returncode}).\n"
            f"{proc.stderr.strip() or '(uv wrote nothing to stderr)'}")

    digest = tree_hash(staging)
    final = STORE / f"{address(identity)}-{version}-{digest[:16]}"
    if final.exists():
        shutil.rmtree(staging)
        return final, False

    (staging / PIN_MARKER).write_text(pin + "\n")
    (staging / HASH_MARKER).write_text(digest + "\n")
    # The sandbox reads this tree as uid 1000, which under rootless podman is a
    # different subuid than the one that wrote it.
    subprocess.run(["chmod", "-R", "a+rX", str(staging)], check=True)
    return _publish_store_dir(staging, final)


def _publish_store_dir(staging: Path, final: Path) -> tuple[Path, bool]:
    """Publish a staged tree at its content address, and converge on one copy.

    Acquisition runs are parallel, thus two runs can stage one distribution
    and reach this rename together. The rename of the second run fails, the
    address is the content, thus the second run keeps the published copy.
    """
    try:
        staging.rename(final)
    except OSError:
        if not final.is_dir():
            raise
        shutil.rmtree(staging, ignore_errors=True)
        return final, False
    return final, True


def store_dir_name(path: str) -> str | None:
    """The distribution name of the store directory that `path` sits inside."""
    parts = Path(path).parts
    for i, part in enumerate(parts):
        if part == STORE.name and i + 1 < len(parts):
            head = parts[i + 1].rsplit("-", 2)[0]
            return head or None
    return None


# --- The farm --------------------------------------------------------------


def link_tree(dst: Path, src: str, conflicts: list[dict]) -> None:
    """Symlink every entry of `src` into `dst`, merging directories on collision.

    Two distributions that share a top-level name — a namespace package such
    as `mpl_toolkits` — cannot both be a symlink at one point, thus the shared
    prefix promotes to a real directory and both sides link beneath it.

    Two versions of ONE distribution are the exception, and they raise. A farm
    links one directory for a top-level name, thus the second version would
    shadow the first, and an import would read a version that no lock names.
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
            if previous == target:
                continue
            previous_name, target_name = store_dir_name(previous), store_dir_name(target)
            if previous_name is not None and previous_name == target_name:
                raise SystemExit(
                    f"[provision] refusing to farm {entry}: two versions of {previous_name} "
                    f"reach one farm ({previous} vs {target}). A farm resolves one version "
                    f"for a name, thus one version would shadow the other.")
            if os.path.isdir(previous) and os.path.isdir(target):
                link.unlink()
                link.mkdir()
                link_tree(link, previous, conflicts)
                link_tree(link, target, conflicts)
            else:
                conflicts.append({"entry": entry, "action": "kept-first"})
        elif link.is_dir() and os.path.isdir(target):
            link_tree(link, target, conflicts)
        else:
            conflicts.append({"entry": entry, "action": "skipped"})


def build_python_track(farm: Path, store_dirs: list[Path]) -> list[dict]:
    """Assemble the python track of a farm from its closure's store dirs."""
    # A farm's links are absolute targets under LIBS, and the sandbox resolves
    # them at its own mount. They line up only when the provisioner sees the
    # store at the same path the sandbox will.
    if LIBS != SANDBOX_MOUNT:
        raise SystemExit(
            f"[provision] refusing to build a farm: store root {LIBS} is not the "
            f"sandbox mount {SANDBOX_MOUNT}; farm links would bake a path the sandbox "
            f"cannot resolve (set SANDBOX_LIB_MOUNT if the sandbox mounts elsewhere)")
    site = farm / "python" / "site-packages"
    site.mkdir(parents=True, exist_ok=True)
    # The r/ subtrees are NOT pre-created. An empty directory would advertise
    # an empty R track to the inventory.

    conflicts: list[dict] = []
    for store_dir in store_dirs:
        link_tree(site, str(store_dir), conflicts)

    # Console scripts land in <target>/bin under `uv pip install --target`.
    # Hoist them, thus the sandbox puts one directory on PATH. Each hoisted
    # link is RELATIVE to the farm's own site-packages: the farm publishes by
    # a rename, and an absolute link would keep the staging path and dangle.
    if (site / "bin").is_dir():
        binroot = farm / "python" / "bin"
        binroot.mkdir(parents=True, exist_ok=True)
        for entry in sorted(os.listdir(site / "bin")):
            if entry in NOT_CONTENT:
                continue
            link = binroot / entry
            if link.is_symlink() or link.exists():
                link.unlink()
            link.symlink_to(f"../site-packages/bin/{entry}")

    log(f"farm: {len(list(site.iterdir()))} top-level entries, {len(conflicts)} merge conflict(s)")
    for c in conflicts:
        log(f"  merge conflict {c['entry']}: {c['action']}")
    return conflicts


def _renameat2_exchange(old: Path, new: Path) -> None:
    """Atomically exchange two existing paths with renameat2(RENAME_EXCHANGE)."""
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

    `staging` holds the complete new farm — its links AND its `inflexa.lock`,
    which writes last — thus the swap never exposes a farm that the mount gate
    accepts and that is not complete.
    """
    if not farm.exists():
        os.rename(staging, farm)
        return
    try:
        _renameat2_exchange(staging, farm)
    except (OSError, AttributeError):
        # No RENAME_EXCHANGE here. Move the old farm aside under a well-known
        # name, then move the new farm in. A crash between the two renames
        # leaves the old farm at FARM_SUPERSEDED, and the repair step restores it.
        superseded = farm.parent / (FARM_SUPERSEDED + farm.name)
        if superseded.exists():
            shutil.rmtree(superseded)
        os.rename(farm, superseded)
        os.rename(staging, farm)
        shutil.rmtree(superseded, ignore_errors=True)
        return
    shutil.rmtree(staging, ignore_errors=True)


# --- The R track -------------------------------------------------------------

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
    """Bare names of the LinkingTo packages of an installed R package."""
    lines = (pkg_dir / "DESCRIPTION").read_text(errors="replace").splitlines()
    value: str | None = None
    for index, line in enumerate(lines):
        if line.startswith("LinkingTo:"):
            value = line.split(":", 1)[1]
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


def store_r_package(pkg_dir: Path, qualifier: str = "",
                    record: dict | None = None) -> tuple[Path, bool]:
    """Content-address an installed R package directory into the store.

    The store DIRECTORY carries the address of the identity, and it nests the
    package one level down under the identity NAME: R rebuilds its own path as
    libname/packagename, and the nesting is what makes that resolve. renv's
    cache proves the layout.

    `qualifier` is the source suffix of a source-built root (`@git:<full sha>`
    or `@tree:<sha16>`): it rides the pin marker alone, and the directory name
    keeps the bare version, because emit_deps derives the node version from
    the directory name. `record` is the build record, written beside the pin
    marker and out of the content address with it.
    """
    name, version = read_r_pkg(pkg_dir)
    identity = r_identity(name)
    pin = f"{name}=={version}{qualifier}"
    existing = find_stored(pin, "r")
    if existing is not None:
        return existing, False
    wrap = pkg_dir.parent / f".wrap-{pkg_dir.name}"
    if wrap.exists():
        shutil.rmtree(wrap)
    wrap.mkdir()
    pkg_dir.rename(wrap / name)
    inner = wrap / name
    digest = tree_hash(wrap)
    final = STORE / f"{address(identity)}-{version}-{digest[:16]}"
    if final.exists():
        shutil.rmtree(wrap)
        return final, False
    (inner / PIN_MARKER).write_text(pin + "\n")
    (inner / HASH_MARKER).write_text(digest + "\n")
    (inner / R_LINKING_MARKER).write_text(json.dumps(read_r_linking(inner)) + "\n")
    if record is not None:
        (inner / BUILD_MARKER).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    subprocess.run(["chmod", "-R", "a+rX", str(wrap)], check=True)
    return _publish_store_dir(wrap, final)


def stage_r_subtrees(stage_root: Path, r_names: dict[str, list[str]],
                     ) -> tuple[dict[str, list[tuple[str, Path]]], list[dict]]:
    """Store each staged R package, and record each store directory once.

    The github stage installs every dependency of a repository into the
    github library, even one that the bulk libraries already hold, because
    `pak::pkg_install(lib=)` reads "installed" from that one library alone.
    The reinstall carries the same version and the same bytes, thus the
    store answers with the same content-addressed directory. That address
    is the exact test of "the same package", and a directory that an
    earlier subtree recorded is not a github entry: the github subtree
    holds only what the repositories add, the lock holds one entry per
    directory, and the load check loads each package once. A different
    version has a different address, and it stays: the github library
    precedes the bulk libraries on the load path, thus that version is the
    one that loads.
    """
    stored: dict[str, list[tuple[str, Path]]] = {sub: [] for sub in R_SUBTREES}
    packages: list[dict] = []
    seen: set[Path] = set()
    for sub in R_SUBTREES:
        libdir = stage_root / "r" / sub
        if not libdir.is_dir():
            continue
        repeated = 0
        for pkg_dir in sorted(p for p in libdir.iterdir() if (p / "DESCRIPTION").is_file()):
            name, _version = read_r_pkg(pkg_dir)
            store_dir, _is_new = store_r_package(pkg_dir)
            if store_dir in seen:
                repeated += 1
                continue
            seen.add(store_dir)
            stored[sub].append((name, store_dir))
            packages.append(lock_package_entry(store_dir, sub, r_entry_requested(name, r_names)))
        if repeated:
            log(f"R {sub}: {repeated} package(s) are directories that an earlier subtree recorded; each recorded once")
    return stored, packages


def build_r_track(farm: Path, stored: dict[str, list[tuple[str, Path]]]) -> None:
    """Link stored R packages into farm/r/{cran,bioconductor,github}."""
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
            # The target is the inner directory, whose basename is the real
            # package name.
            link.symlink_to(str(store_dir / name))


# Bioconductor serves every artifact of a release under `.../packages/<release>/`.
BIOC_RELEASE_IN_URL = re.compile(r"https?://[^/]*bioconductor[^/]*/packages/(\d+\.\d+)(?:/|$)")


def bioc_releases(lock: dict) -> list[str]:
    """The Bioconductor releases that a pak lock names, sorted, no duplicate."""
    packages = lock.get("packages") if isinstance(lock, dict) else None
    if not isinstance(packages, list):
        return []
    found: set[str] = set()
    for pkg in packages:
        if not isinstance(pkg, dict):
            continue
        urls = pkg.get("sources")
        candidates = list(urls) if isinstance(urls, list) else []
        metadata = pkg.get("metadata")
        if isinstance(metadata, dict):
            candidates.append(metadata.get("RemoteRepos"))
        for candidate in candidates:
            if isinstance(candidate, str):
                found.update(BIOC_RELEASE_IN_URL.findall(candidate))
    return sorted(found, key=lambda release: tuple(int(part) for part in release.split(".")))


def r_runtime_version() -> str:
    proc = subprocess.run(["Rscript", "-e", "cat(as.character(getRversion()))"],
                          capture_output=True, text=True)
    return proc.stdout.strip() if proc.returncode == 0 else ""


def python_runtime_version() -> str:
    proc = subprocess.run([PYTHON, "-c", "import platform; print(platform.python_version())"],
                          capture_output=True, text=True)
    return proc.stdout.strip() if proc.returncode == 0 else ""


# --- inflexa.lock ------------------------------------------------------------
# One schema-versioned `inflexa.lock` is the whole metadata surface of a farm.
# It replaces packages.txt, meta.json, lock.json, and the per-track fragments.
# The mount gate of the harness and the package inventory read this one file.

LOCK_NAME = "inflexa.lock"
LOCK_SCHEMA = 1


def _github_wanted_names(refs: list[str]) -> set[str]:
    """The normalized repository tails of the github track.

    A github manifest entry names a repository, and the installed package
    names itself in its DESCRIPTION. The two agree only loosely — the case
    and the punctuation differ (seurat-disk installs SeuratDisk). Thus the
    comparison keeps letters and digits alone, in lower case.
    """
    out: set[str] = set()
    for ref in refs:
        tail = ref.split("/")[-1].split("@")[0]
        out.add(re.sub(r"[^a-z0-9]", "", tail.lower()))
    return out


def r_entry_requested(name: str, r_names: dict[str, list[str]]) -> bool:
    """Whether a farm-lock entry records a direct manifest ask.

    The bulk tracks name packages, and the github track names repositories.
    A repository tail and the DESCRIPTION name of its package agree only
    loosely, thus the github comparison normalizes both sides.
    """
    for key in ("cran", "bioconductor", "git"):
        if name in (r_names.get(key) or []):
            return True
    tail = re.sub(r"[^a-z0-9]", "", name.lower())
    return tail in _github_wanted_names(r_names.get("github") or [])


def carry_held_r_entries(old_lock: dict, stored: dict[str, list[tuple[str, Path]]],
                         r_wanted: dict[str, list[str]],
                         graph: dict) -> list[tuple[str, str, Path, bool]]:
    """The held R entries that the new farm keeps after a failed install.

    A build links only what staged in its own round, thus one bad round
    would remove a good package from the published farm — the farm-level
    twin of a moved edge. An entry carries over when the previous farm
    advertised it, the pool still holds its directory, and the manifest
    still wants it. A dependency carries over only when a kept requested
    entry reaches it through the graph, thus a removed root takes its
    private dependencies with it.
    """
    staged = {name.lower() for pkgs in stored.values() for name, _ in pkgs}
    wanted = {
        "cran": {n.lower() for n in r_wanted.get("cran") or []},
        "bioconductor": {n.lower() for n in r_wanted.get("bioconductor") or []},
        "github": _github_wanted_names(r_wanted.get("github") or []),
    }
    roots: list[dict] = []
    deps: list[dict] = []
    for entry in old_lock.get("packages", []):
        track = entry.get("track")
        if track not in R_SUBTREES:
            continue
        if entry["name"].lower() in staged:
            continue
        if not (STORE / entry["store_dir"]).is_dir():
            continue
        name = entry["name"].lower()
        key = re.sub(r"[^a-z0-9]", "", name) if track == "github" else name
        # A lock from before the requested-flag repair marks every github
        # entry as a dependency, thus the manifest match promotes a github
        # entry — the flag alone does not decide.
        if key in wanted[track] and (entry.get("requested") or track == "github"):
            roots.append(entry)
        elif entry.get("requested"):
            continue
        else:
            deps.append(entry)

    nodes = graph.get("nodes", {})
    reachable: set[str] = set()
    frontier = [entry["store_dir"] for entry in roots]
    while frontier:
        key = frontier.pop()
        if key in reachable:
            continue
        reachable.add(key)
        frontier.extend(nodes.get(key, {}).get("edges", []))

    # A root is a manifest ask by construction, thus the flag of a stale lock
    # does not ride into the new entry.
    kept = [(entry, True) for entry in roots]
    kept += [(entry, False) for entry in deps if entry["store_dir"] in reachable]
    return [(entry["track"], entry["name"], STORE / entry["store_dir"], requested)
            for entry, requested in kept]


def lock_package_entry(store_dir: Path, track: str, requested: bool) -> dict:
    """One `packages` entry of the farm lock, for one linked store directory."""
    if track == "python":
        pin = (store_dir / PIN_MARKER).read_text().strip()
    else:
        inner = next(p for p in store_dir.iterdir() if p.is_dir() and (p / PIN_MARKER).is_file())
        pin = (inner / PIN_MARKER).read_text().strip()
    name, version = pin.split("==", 1)
    return {
        "name": name,
        "version": version,
        "track": track,
        "store_dir": store_dir.name,
        "hash": stored_full_hash(store_dir),
        # `requested` obeys the PEP 376 meaning: true for a direct ask, false
        # for a transitive dependency.
        "requested": requested,
    }


def write_farm_lock(farm: Path, lock: dict) -> None:
    """Write the farm lock in one step: a temp file, then a rename.

    Inside a staging farm this is also the LAST write of the build, thus a
    crash before it leaves a staging that the mount gate refuses.
    """
    path = farm / LOCK_NAME
    temp = farm / (LOCK_NAME + ".tmp")
    temp.write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n")
    os.replace(temp, path)


# --- The locks -----------------------------------------------------------------
# One lock file carries two modes. An acquisition run takes the shared mode,
# because content addressing makes the pool writes race-safe. Reclaim and a
# farm removal take the exclusive mode, because each reads the whole store and
# deletes from it. A second lock file is the short commit mutex that
# serializes each write to the shared metadata. A run takes the store lock
# first and the commit mutex second, and no code takes them in the other
# order, thus no deadlock is possible.


@contextlib.contextmanager
def _flock(path: Path, mode: int, wait: bool, busy: str):
    LIBS.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        try:
            fcntl.flock(fd, mode | fcntl.LOCK_NB)
        except OSError:
            if not wait:
                raise SystemExit(f"[provision] {busy}; retry when it finishes")
            log(f"{busy}; this step waits for it to finish")
            fcntl.flock(fd, mode)
        yield fd
    finally:
        os.close(fd)


@contextlib.contextmanager
def store_lock(shared: bool, wait: bool = True):
    """Hold the store lock, and repair abandoned staging debris on the way in.

    The repair runs when this process is the only holder — a non-blocking
    exclusive probe proves that no other run is in flight, thus every staging
    tree present is debris from a crashed run, never the work of a live one.
    When another run holds the lock, the repair skips: the next run that
    enters alone clears the debris. Thus the repair is automatic at the start
    of each run, and it never deletes the staging of a run in flight.
    """
    LIBS.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(LIBS / ".provision.lock"), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        alone = False
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            alone = True
        except OSError:
            pass
        if alone:
            repair_staging()
            if shared:
                # Downgrade to the shared mode, thus a parallel acquire can
                # join this run.
                fcntl.flock(fd, fcntl.LOCK_SH)
        elif shared:
            # The exclusive holder can be a reclaim, or another run inside its
            # own repair probe — the probe holds the exclusive mode for one
            # instant. The two are not tellable apart through the lock, thus
            # the shared path retries over a short bound before it refuses. A
            # probe clears within it, and a real reclaim persists past it.
            deadline = time.monotonic() + 2.0
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise SystemExit("[provision] reclaim holds the store lock; retry when it finishes")
                    time.sleep(0.02)
        else:
            if not wait:
                raise SystemExit("[provision] an acquisition run holds the store lock; retry when it finishes")
            log("an acquisition run holds the store lock; this step waits for it to finish")
            fcntl.flock(fd, fcntl.LOCK_EX)
            repair_staging()
        yield
    finally:
        os.close(fd)


@contextlib.contextmanager
def commit_lock():
    """Hold the short mutex that serializes each write to the shared metadata."""
    with _flock(LIBS / ".commit.lock", fcntl.LOCK_EX, True,
                "another run commits its metadata"):
        yield


# --- Repair --------------------------------------------------------------------


def recover_farm(farm_name: str) -> list[str]:
    """Recover an interrupted swap of one farm, and clear the debris of that farm."""
    cleared: list[str] = []
    farm = FARMS / farm_name
    sup = FARMS / (FARM_SUPERSEDED + farm_name)
    stg = FARMS / (FARM_STAGING + farm_name)
    if sup.exists():
        if farm.exists():
            shutil.rmtree(sup, ignore_errors=True)
            cleared.append(f"farms/{sup.name}")
        else:
            if stg.exists():
                shutil.rmtree(stg, ignore_errors=True)
            os.rename(sup, farm)
            cleared.append(f"farms/{sup.name} (restored {farm_name})")
    if stg.exists():
        shutil.rmtree(stg, ignore_errors=True)
        cleared.append(f"farms/{stg.name}")
    return cleared


def repair_staging() -> None:
    """Clear every abandoned staging tree, and recover each interrupted swap.

    Runs only while this process is the sole store-lock holder (refer to
    store_lock), thus every staging tree present is debris.
    """
    cleared = []
    if STORE.is_dir():
        for d in sorted(STORE.glob(".staging*")):
            shutil.rmtree(d, ignore_errors=True)
            cleared.append(f"store/{d.name}")
    if FARMS.is_dir():
        names = {p.name[len(FARM_SUPERSEDED):] for p in FARMS.glob(FARM_SUPERSEDED + "*")}
        names |= {p.name[len(FARM_STAGING):] for p in FARMS.glob(FARM_STAGING + "*")}
        for farm_name in sorted(names):
            cleared += recover_farm(farm_name)
    if cleared:
        log("repair: cleared abandoned " + ", ".join(cleared))


# --- reclaim / remove-farm ------------------------------------------------------


def _referenced_store_dirs() -> set[str]:
    """Store directory names that any farm links to."""
    referenced: set[str] = set()
    if not FARMS.is_dir():
        return referenced
    for farm in FARMS.iterdir():
        if not farm.is_dir() or farm.name.startswith("."):
            continue
        for link in farm.rglob("*"):
            if link.is_symlink():
                tgt = os.readlink(link)
                if "/store/" in tgt:
                    referenced.add(tgt.split("/store/", 1)[1].split("/", 1)[0])
    return referenced


def _prune_dangling_nodes() -> int:
    """Drop every deps.json node whose store directory is gone, and thin
    `by_name` to match.

    The graph is the advertised truth of the pool. A node that outlives its
    directory advertises a package that no link can land, and the composition
    then refuses on a store_dir that does not exist. The sweep keys on the
    disk, not on this run's removal list, thus a node that dangled before the
    run heals too.
    """
    deps_path = LIBS / "deps.json"
    if not deps_path.is_file():
        return 0
    graph = json.loads(deps_path.read_text())
    nodes = graph.get("nodes", {})
    gone = [d for d in nodes if not (STORE / d).is_dir()]
    if not gone:
        return 0
    for d in gone:
        del nodes[d]
        log(f"  pruned graph node {d}")
    for track_names in graph.get("by_name", {}).values():
        for name in list(track_names):
            kept = [d for d in track_names[name] if d in nodes]
            if kept:
                track_names[name] = kept
            else:
                del track_names[name]
    temp = deps_path.with_name(deps_path.name + ".tmp")
    temp.write_text(json.dumps(graph, indent=2, sort_keys=True) + "\n")
    os.replace(temp, deps_path)
    return len(gone)


def _graph_node_dirs() -> set[str]:
    """Store directory names that deps.json advertises."""
    deps_path = LIBS / "deps.json"
    if not deps_path.is_file():
        return set()
    return set(json.loads(deps_path.read_text()).get("nodes", {}))


def cmd_reclaim(args) -> int:
    """Remove store directories that no farm links AND the graph does not
    advertise, and prune the graph nodes whose directories are gone.

    A graph-advertised directory is pool inventory, never waste, for two
    reasons. A locally acquired package holds no farm link until a run
    links it, thus "no farm link" marks fresh inventory as well as waste.
    And an edge of a surviving node must keep a target: a removal that
    ignores edges leaves the graph with a dangling edge, and the strict
    graph reader then refuses the WHOLE pool. Explicit and host-invoked,
    never automatic.

    With --debris the pass additionally removes the stale acquire and
    source-build reports, and it never rewrites the graph — the boot pass and the flush tail call
    it, thus it stays cheap and write-free on the metadata.
    """
    debris = bool(getattr(args, "debris", False))
    with store_lock(shared=False):
        if not STORE.is_dir():
            log("reclaim: no store")
            return 0
        referenced = _referenced_store_dirs() | _graph_node_dirs()
        removed = 0
        for d in sorted(STORE.iterdir()):
            if not d.is_dir() or d.name.startswith("."):
                continue
            if d.name not in referenced:
                shutil.rmtree(d, ignore_errors=True)
                removed += 1
                log(f"  reclaimed {d.name}")
        if debris:
            reports = 0
            download = LIBS / ".inflexa-download"
            if download.is_dir():
                stale = sorted([*download.glob("acquire-*.json"), *download.glob("source-*.json")])
                for report in stale:
                    report.unlink(missing_ok=True)
                    reports += 1
                    log(f"  removed stale report {report.name}")
            log(f"reclaim --debris: {removed} debris dir(s) removed, "
                f"{reports} stale report(s) removed")
            return 0
        pruned = _prune_dangling_nodes()
        log(f"reclaim: {removed} unreferenced store dir(s) removed, "
            f"{pruned} graph node(s) pruned, {len(referenced)} still referenced")
        return 0


def cmd_remove_farm(args) -> int:
    """Remove one farm — the symlink set of one analysis — and never the pool.

    No lease guards the removal: the host gates its own delete flow on live
    work, and that gate is the one guard.
    """
    with store_lock(shared=False):
        farm = FARMS / args.name
        if not farm.is_dir():
            log(f"remove-farm: no such farm {args.name}")
            return 2
        shutil.rmtree(farm, ignore_errors=True)
        log(f"removed farm {args.name} (run reclaim to drop store dirs it alone referenced)")
        return 0


# --- acquire ---------------------------------------------------------------------


# The location message of a URL and of a local path. Neither names a package,
# and both bypass the pinned index.
_NOT_A_PACKAGE = "a location is not a package request — name the package as a requirement"


def _location_body(entry: str) -> str:
    """The location that a spec wrote, without a `python:` or `r:` prefix.

    `parse_query` refuses a location before it reads the prefix, thus the entry
    of the error still carries one. A classification over the whole entry then
    reads `python:./vendor/pkg` as a repository, because the colon form hides
    the leading dot. Only the two track prefixes strip: `https:` is a scheme
    and not a track, and the caller tests `://` before this function runs.
    """
    for track in TRACKS:
        if entry.startswith(f"{track}:"):
            return entry[len(track) + 1:]
    return entry


def refusal_reason(error: QueryError) -> str:
    """The refusal text of one spec that `parse_query` would not read.

    A location bypasses the index and its hashes, thus the reason names which
    kind of location the spec wrote: a URL or a local path, an artifact file,
    or a repository. A repository is the github or git form, and those tracks
    are catalog-only — the manifest carries them, and an acquisition refuses.
    """
    entry = error.entry
    if error.type == "location":
        # A URL settles first, because its scheme carries the same `://` that
        # a suffix rule cannot see: `https://x/y.whl` is a URL, not a file
        # beside the caller.
        if "://" in entry:
            return _NOT_A_PACKAGE
        body = _location_body(entry)
        # A path settles next. A leading `.`, `~`, or `/` is a path and never
        # an `owner/repo` form, whatever the name at the end of it looks like.
        if body.startswith((".", "~", "/", "\\")):
            return _NOT_A_PACKAGE
        if body.endswith((".whl", ".tar.gz", ".zip")):
            return "an artifact file bypasses the pinned index and its hashes"
        if "/" in body:
            return ("the github and git tracks are catalog-only — an acquisition "
                    "covers CRAN, Bioconductor, and the Python index")
        return _NOT_A_PACKAGE
    if error.type == "unknown_prefix":
        return (f"the prefix {error.prefix!r} names no ecosystem — the permitted "
                "prefixes are 'python:' and 'r:', and a bare name searches both")
    if error.type == "unsupported_specifier":
        return (f"the specifier {error.specifier!r} is not an exact pin — name the "
                "package as a bare name, or as name==version")
    return "an empty spec names no package"


def reject_off_index(query: PackageQuery) -> str | None:
    """The refusal reason for a query that names an artifact file, or None.

    A wheel or a source archive is a legal distribution NAME by the grammar,
    thus the parser reads it. It is not a legal ask of this provisioner: the
    install runs against the pinned index under `--require-hashes`, and a file
    name bypasses both.
    """
    if query.spelling.endswith((".whl", ".tar.gz", ".zip")):
        return "an artifact file bypasses the pinned index and its hashes"
    return None


def python_index_holds(name: str) -> bool:
    """A presence probe of one name against the pinned Python index."""
    url = f"{INDEX_URL.rstrip('/')}/{python_identity(name).name}/"
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            return response.status == 200
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise SystemExit(f"[provision] the index probe of {name} failed: HTTP {exc.code}")
    except OSError as exc:
        raise SystemExit(f"[provision] the index probe of {name} failed: {exc}")


def r_repos_hold(names: list[str]) -> dict[str, bool]:
    """A presence probe of names against CRAN and Bioconductor, through pak."""
    if not names:
        return {}
    proc = subprocess.run(
        ["Rscript", "/usr/local/bin/acquire_r.R", "probe", json.dumps(names)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(
            f"[provision] the R presence probe failed (exit {proc.returncode}).\n"
            f"{proc.stderr.strip() or '(R wrote nothing to stderr)'}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


def _pool_constraints() -> Path | None:
    """The shelf-head pins of the Python track, as a uv constraints file.

    A blind resolve can mint a second pin of a dependency the pool already
    holds, and two pins of one name refuse at farm composition. The head
    pins ride as constraints, thus the resolve reuses a held pin whenever
    the ranges permit it. The caller drops the constraints on a conflict,
    so a true conflict still lands its pin. A missing or unreadable graph
    gives no constraints, because a fresh store has nothing to converge on.
    """
    deps_path = LIBS / "deps.json"
    if not deps_path.is_file():
        return None
    try:
        graph = json.loads(deps_path.read_text())
    except ValueError:
        return None
    nodes = graph.get("nodes", {})
    lines: list[str] = []
    for name, dirs in graph.get("by_name", {}).get("python", {}).items():
        head = nodes.get(dirs[0]) if dirs else None
        version = (head or {}).get("version")
        if version:
            lines.append(f"{name}=={version}")
    if not lines:
        return None
    path = run_temp("pool-constraints.txt")
    path.write_text("\n".join(sorted(lines)) + "\n")
    return path


def acquire_python_spec(query: PackageQuery, raw: str) -> dict:
    """Acquire one Python query: its own closure into the pool.

    Per-spec resolution is correct for a pool: the pool holds many versions,
    and a farm resolves one at link time. Two specs whose closures share a
    distribution converge on one store directory by content address, thus the
    shared dependency installs once. The resolve rides the pool pins as
    constraints, and a conflict drops them — refer to `_pool_constraints`.
    """
    requirement = query.spelling + (f"=={query.version}" if query.version else "")
    try:
        constraints = _pool_constraints()
        if constraints is None:
            pins = resolve([requirement])
        else:
            try:
                pins = resolve([requirement], constraints)
            except ResolveError:
                log("the held pins conflict with the spec; resolving fresh")
                pins = resolve([requirement])
        store_dirs: list[Path] = []
        installed: list[str] = []
        for pin in pins:
            path, is_new = ensure_stored(pin, pins[pin])
            store_dirs.append(path)
            if is_new:
                installed.append(pin)
    except ResolveError as exc:
        return {"spec": raw, "outcome": "refused", "reason": str(exc)}
    return {
        "spec": raw,
        "outcome": "acquired",
        "ecosystem": "python",
        "installed": installed,
        "reused": [p for p in pins if p not in installed],
        "store_dirs": [d.name for d in store_dirs],
    }


def acquire_r_spec(query: PackageQuery, raw: str) -> dict:
    """Acquire one R query through pak, against CRAN and Bioconductor only.

    The resolve names the closure. An entry that the pool already holds at the
    resolved version links from the pool and never installs again — the
    needed subset alone installs, into a private staging library. The pak lock
    of the acquisition rides in the outcome as provenance.
    """
    ref = query.spelling + (f"@{query.version}" if query.version else "")
    spec_address = address(r_identity(query.spelling))
    lock_out = run_temp(f"pak-lock-{spec_address}.json")
    proc = subprocess.run(
        ["Rscript", "/usr/local/bin/acquire_r.R", "resolve", ref, str(lock_out)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return {"spec": raw, "outcome": "refused",
                "reason": (proc.stderr.strip() or "pak could not resolve the request")}
    pak_lock = json.loads(lock_out.read_text())
    entries = [
        {"name": p["package"], "version": p["version"]}
        for p in pak_lock.get("packages", [])
        if isinstance(p, dict) and p.get("package") and p.get("version")
    ]

    # The pool-hit reuse: an entry that the pool holds at the resolved version
    # never installs again. The lock filters to the needed subset, and pak
    # installs exactly that subset — lockfile_install re-resolves nothing.
    needed_names = {e["name"] for e in entries
                    if find_stored(f"{e['name']}=={e['version']}", "r") is None}
    staging = staging_dir("r") / spec_address
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    if needed_names:
        filtered = dict(pak_lock)
        filtered["packages"] = [p for p in pak_lock.get("packages", [])
                                if isinstance(p, dict) and p.get("package") in needed_names]
        filtered_path = run_temp(f"pak-lock-needed-{spec_address}.json")
        filtered_path.write_text(json.dumps(filtered) + "\n")
        proc = subprocess.run(
            ["Rscript", "/usr/local/bin/acquire_r.R", "install", str(filtered_path), str(staging)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            shutil.rmtree(staging, ignore_errors=True)
            return {"spec": raw, "outcome": "refused",
                    "reason": (proc.stderr.strip() or "pak could not install the resolved set")}

    store_dirs: list[Path] = []
    installed: list[str] = []
    for pkg_dir in sorted(p for p in staging.iterdir() if (p / "DESCRIPTION").is_file()):
        name, version = read_r_pkg(pkg_dir)
        store_dir, is_new = store_r_package(pkg_dir)
        store_dirs.append(store_dir)
        if is_new:
            installed.append(f"{name}=={version}")
    for entry in entries:
        hit = find_stored(f"{entry['name']}=={entry['version']}", "r")
        if hit is not None and hit not in store_dirs:
            store_dirs.append(hit)
    shutil.rmtree(staging, ignore_errors=True)

    return {
        "spec": raw,
        "outcome": "acquired",
        "ecosystem": "r",
        "installed": installed,
        "reused": [f"{e['name']}=={e['version']}" for e in entries
                   if f"{e['name']}=={e['version']}" not in installed],
        "store_dirs": [d.name for d in store_dirs],
        "pak_lock": pak_lock,
    }


def cmd_acquire(args) -> int:
    """Acquire a spec set into the pool, and stage the graph nodes for the host.

    The two-phase contract: this run publishes no advertised state. It writes
    the pool (content-addressed, write-once) and one report file that carries
    the outcome of each spec and the staged graph nodes. It never touches
    deps.json. The host runs the load check of the acquired set inside the
    sandbox image, and only after the green check does the host append the
    staged nodes to deps.json under its metadata lock. A failed check leaves
    no advertised state, and reclaim frees the orphaned bytes.
    """
    global RUN_TOKEN
    RUN_TOKEN = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"

    if not args.specs:
        log("acquire: no spec given")
        return 2

    with store_lock(shared=True):
        STORE.mkdir(parents=True, exist_ok=True)
        outcomes: list[dict] = []
        pending: list[tuple[str, PackageQuery]] = []
        for raw in args.specs:
            try:
                query = parse_query(raw)
            except QueryError as error:
                outcomes.append({"spec": raw, "outcome": "refused",
                                 "reason": refusal_reason(error)})
                continue
            reason = reject_off_index(query)
            if reason is not None:
                outcomes.append({"spec": raw, "outcome": "refused", "reason": reason})
                continue
            pending.append((raw, query))

        # The both-hit stop. An unqualified name searches both ecosystems.
        # When both hold it, the run stops that spec with the two identities,
        # and the host asks the user. A silent Python-first win is a fault.
        unqualified = [query for _raw, query in pending if query.track is None]
        r_presence = r_repos_hold([query.spelling for query in unqualified])
        ready: list[tuple[str, PackageQuery]] = []
        for raw, query in pending:
            if query.track is not None:
                ready.append((raw, query))
                continue
            in_python = python_index_holds(query.spelling)
            in_r = bool(r_presence.get(query.spelling, False))
            if in_python and in_r:
                # The R probe matches a name exactly, thus an R hit means that
                # the spelling IS the R identity.
                outcomes.append({
                    "spec": raw,
                    "outcome": "both_hit",
                    "candidates": [
                        key(python_identity(query.spelling)),
                        key(r_identity(query.spelling)),
                    ],
                })
            elif in_python:
                ready.append((raw, PackageQuery(query.spelling, "python", query.version)))
            elif in_r:
                ready.append((raw, PackageQuery(query.spelling, "r", query.version)))
            else:
                outcomes.append({"spec": raw, "outcome": "refused",
                                 "reason": "no ecosystem holds the name"})

        # One outcome per spec. A spec that cannot resolve drops out with its
        # own refusal, and the rest of the set still lands.
        acquired_dirs: list[Path] = []
        for raw, query in ready:
            outcome = (acquire_python_spec(query, raw) if query.track == "python"
                       else acquire_r_spec(query, raw))
            outcomes.append(outcome)
            if outcome["outcome"] == "acquired":
                acquired_dirs.extend(STORE / name for name in outcome["store_dirs"])
        shutil.rmtree(staging_dir("python"), ignore_errors=True)
        shutil.rmtree(staging_dir("r"), ignore_errors=True)

        # The staged graph nodes — one data file, and deps.json stays
        # untouched. The nodes resolve their edges inside the acquired set
        # plus the published graph, thus the gate of the host commit holds.
        unique_dirs = sorted({d for d in acquired_dirs if d.is_dir()}, key=lambda d: d.name)
        nodes = emit_deps.collect(unique_dirs) if unique_dirs else {}
        report = {
            "schema": 1,
            "arch": arch(),
            "outcomes": outcomes,
            "nodes": nodes,
        }
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        temp = report_path.with_suffix(report_path.suffix + ".tmp")
        temp.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        os.replace(temp, report_path)

    acquired = sum(1 for o in outcomes if o["outcome"] == "acquired")
    log(f"acquire: {acquired}/{len(args.specs)} spec(s) acquired; report at {args.report}; "
        f"deps.json untouched — the host commits after the load check")
    return 0


# --- acquire-source -------------------------------------------------------------


# The output directory the script contract names: the approved script builds
# exactly one root artifact into it. The clean run and the session agree on
# this path, and the option exists for a host that mounts it elsewhere.
DEFAULT_BUILD_OUT = "/work/out"

# The launch environment carries both image digests, because a process inside
# the container cannot read its own image digest: the host names the provisioner
# image it ran and the base image both images share, and the build record
# copies the two values verbatim.
PROVISIONER_DIGEST_ENV = "INFLEXA_PROVISIONER_DIGEST"
BASE_DIGEST_ENV = "INFLEXA_BASE_IMAGE_DIGEST"

# The dated Ubuntu snapshot every apt source points at once the run pins them.
# A timestamp of the form `YYYYMMDDTHHMMSSZ` selects the snapshot the URL names.
SNAPSHOT_ARCHIVE = "https://snapshot.ubuntu.com/ubuntu"
APT_SOURCES_FILE = "inflexa-snapshot.sources"


def _apt_conf_root() -> Path:
    """The root the apt configuration lives under. `INFLEXA_APT_CONF_ROOT`
    moves it, thus the test suite pins sources inside its temp tree and never
    touches a real `/etc`."""
    return Path(os.environ.get("INFLEXA_APT_CONF_ROOT", "/"))


def _ubuntu_codename(root: Path) -> str:
    """The `VERSION_CODENAME` of the os-release under `root`."""
    release = root / "etc" / "os-release"
    for line in release.read_text(errors="replace").splitlines():
        if line.startswith("VERSION_CODENAME="):
            value = line.split("=", 1)[1].strip().strip('"')
            if value:
                return value
    raise SourceBuildError(
        f"{release} names no VERSION_CODENAME, thus the apt sources cannot name "
        f"the suites of the snapshot {SNAPSHOT_ARCHIVE}")


def pin_apt_sources(snapshot_timestamp: str) -> Path:
    """Point every apt source at the dated Ubuntu snapshot, and drop the
    live-archive sources the image ships.

    The run writes this BEFORE its own `apt-get update` and `apt-get install`
    of the plan's apt packages (install_apt_packages), because those commands
    must obey the pin: a plain update over the live archives would resolve
    versions no dated snapshot served, and the build record's apt block would
    then name versions the snapshot cannot reproduce. The build script itself
    runs without privilege and holds no apt step.
    """
    root = _apt_conf_root()
    sources_dir = root / "etc" / "apt" / "sources.list.d"
    sources_dir.mkdir(parents=True, exist_ok=True)
    codename = _ubuntu_codename(root)
    text = (
        "Types: deb\n"
        f"URIs: {SNAPSHOT_ARCHIVE}/{snapshot_timestamp}/\n"
        f"Suites: {codename} {codename}-updates {codename}-backports {codename}-security\n"
        "Components: main restricted universe multiverse\n"
        "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
        "Check-Valid-Until: no\n")
    written = sources_dir / APT_SOURCES_FILE
    written.write_text(text)
    for other in sources_dir.iterdir():
        if other.name != APT_SOURCES_FILE:
            if other.is_dir():
                shutil.rmtree(other, ignore_errors=True)
            else:
                other.unlink(missing_ok=True)
    (root / "etc" / "apt" / "sources.list").unlink(missing_ok=True)
    return written


class SourceBuildError(Exception):
    """A refusal of one acquire-source run. The command catches it, thus the
    report carries the refusal as its outcome and the host settles a failed
    row, exactly as an index acquisition does."""


def refuse_bad_apt_names(names: list[str]) -> None:
    """Refuse an apt package name that is not a Debian package name, before any
    install. A name such as `-oAPT::Get::AllowUnauthenticated=true` would reach
    apt-get as an option."""
    for name in names:
        if not APT_PACKAGE_NAME.fullmatch(name):
            raise SourceBuildError(
                f"{name!r} is not a Debian package name, thus the run installs no apt package")


def run_logged(argv: list[str], log_path: Path, what: str, **kwargs) -> int:
    """Run `argv` with its combined output in `log_path`, and give the exit code.

    A build can write without bound, thus the output goes to a file and a
    refusal reads only the tail of it (refer to log_tail).
    """
    with open(log_path, "wb") as sink:
        try:
            proc = subprocess.run(argv, stdout=sink, stderr=subprocess.STDOUT,
                                  timeout=BUILD_SCRIPT_TIMEOUT_SECONDS, **kwargs)
        except subprocess.TimeoutExpired:
            raise SourceBuildError(
                f"{what} ran past {BUILD_SCRIPT_TIMEOUT_SECONDS} s, so the run ended it")
    return proc.returncode


def log_tail(log_path: Path, lines: int = 6) -> str:
    """The last `lines` lines of the file, from at most OUTPUT_TAIL_BYTES."""
    with open(log_path, "rb") as handle:
        size = handle.seek(0, os.SEEK_END)
        handle.seek(max(0, size - OUTPUT_TAIL_BYTES))
        data = handle.read()
    return "\n".join(data.decode(errors="replace").strip().splitlines()[-lines:])


def install_apt_packages(names: list[str]) -> None:
    """Install the apt packages of the plan, as root, from the pinned sources.

    The script runs without privilege and cannot call apt-get, thus the run
    installs the packages the plan named before the script starts.
    """
    if not names:
        return
    log_path = run_temp("apt.log")
    env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
    for argv in (["apt-get", "update"],
                 ["apt-get", "install", "-y", "--no-install-recommends", *names]):
        code = run_logged(argv, log_path, f"`{' '.join(argv[:2])}`", env=env)
        if code != 0:
            raise SourceBuildError(
                f"`{' '.join(argv[:2])}` exited non-zero (exit {code}).\n"
                f"{log_tail(log_path) or '(apt-get wrote nothing)'}")


def hide_store_parent(parent: Path) -> None:
    """Make the parent of the store mount readable by root alone.

    uid 1000 on the host can own the read-write store, and the container
    kernel enforces this mode for each engine, thus the script reaches the
    store through the read-only view only.
    """
    os.chmod(parent, 0o700)


def give_to_build_user(path: Path) -> None:
    os.chown(path, BUILD_UID, BUILD_GID)


def store_parent() -> Path:
    """The directory to hide, or a refusal when it is `/`: hiding the root
    directory would lock the run itself out of the system."""
    parent = LIBS.parent
    if parent == parent.parent:
        raise SourceBuildError(
            f"the store mount {LIBS} sits directly under /, thus the run cannot "
            f"hide its parent from the build script")
    return parent


def view_of(library: Path, lib_view: str) -> Path:
    """The path of `library` (a path under LIBS) inside the read-only view."""
    return Path(lib_view) / library.relative_to(LIBS)


def kill_build_user_processes() -> None:
    """KILL each process of the build user that is still alive.

    A script can leave a background process that keeps writing the output
    directory after the script returns, while root reads and publishes that
    output. `kill -1` from the build user signals each process that the user
    may signal, which is the processes of that uid and no other. The exit
    code is ignored: `kill` exits non-zero when no process is left. A refusal
    to run the kill never replaces the outcome of the script.
    """
    try:
        subprocess.run(
            ["setpriv", f"--reuid={BUILD_UID}", f"--regid={BUILD_GID}", "--clear-groups",
             "--", "kill", "-s", "KILL", "--", "-1"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=BUILD_KILL_TIMEOUT_SECONDS)
    except (subprocess.TimeoutExpired, OSError):
        pass


def run_build_script(snapshot: Path, script: Path, output: Path,
                     r_library: Path | None, lib_view: str) -> None:
    """Run the approved script as uid 1000 with no capability and no path to
    the read-write store, and refuse when it fails.

    The script runs from a copy that root owns in a directory that uid 1000
    cannot write, so the script cannot change the bytes that run.
    """
    hide_store_parent(store_parent())
    output.mkdir(parents=True, exist_ok=True)
    give_to_build_user(output)
    env = dict(os.environ)
    env["HOME"] = BUILD_HOME
    if r_library is not None:
        env["R_LIBS_USER"] = str(view_of(r_library, lib_view))
    script_dir = Path(tempfile.mkdtemp(prefix="inflexa-build-script-"))
    try:
        os.chmod(script_dir, 0o755)
        copy = script_dir / "build.sh"
        shutil.copyfile(script, copy)
        os.chmod(copy, 0o755)
        log_path = run_temp("build-output.log")
        try:
            code = run_logged(
                ["setpriv", f"--reuid={BUILD_UID}", f"--regid={BUILD_GID}", "--init-groups",
                 "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs", "--",
                 "bash", str(copy)],
                log_path, "the build script", cwd=str(snapshot), env=env)
        finally:
            # On success, on failure, and on a timeout alike: no process of the
            # script outlives the call, because root reads the output next.
            kill_build_user_processes()
        if code != 0:
            raise SourceBuildError(
                f"the build script exited non-zero (exit {code})."
                f"\n{log_tail(log_path) or '(the script wrote nothing to its streams)'}")
    finally:
        shutil.rmtree(script_dir, ignore_errors=True)


def pak_version() -> str:
    proc = subprocess.run(["Rscript", "-e", 'cat(as.character(packageVersion("pak")))'],
                          capture_output=True, text=True)
    return proc.stdout.strip() if proc.returncode == 0 else ""


def tool_versions() -> dict[str, str]:
    """The versions of the tools a source build compiles against.

    The record names the tools that decide the artifact: the compilers, the
    build tools, and the two runtimes with their resolvers. A tool that answers
    nothing records the empty string rather than stopping the run, because a
    missing version is a gap in the record, not a fault of the artifact that
    the script just built.
    """
    tools = {}
    for name in ("gcc", "g++", "gfortran", "cmake", "uv"):
        proc = subprocess.run([name, "--version"], capture_output=True, text=True)
        first = proc.stdout.strip().splitlines()[0].strip() if proc.stdout.strip() else ""
        tools[name] = first if proc.returncode == 0 else ""
    tools["R"] = r_runtime_version()
    tools["Python"] = python_runtime_version()
    tools["pak"] = pak_version()
    return tools


def apt_versions(names: list[str]) -> dict[str, str]:
    """The installed version of each apt package the plan named, from dpkg.

    The run's own apt-get install (install_apt_packages) ran in THIS container
    before the script, thus dpkg holds the versions the run installed. A plan
    names names; the record holds what installed. A
    package dpkg does not know records the empty string, never a refusal: the
    artifact is built, and the record states the gap.
    """
    out: dict[str, str] = {}
    for name in names:
        proc = subprocess.run(["dpkg-query", "-W", "-f=${Version}", name],
                              capture_output=True, text=True)
        out[name] = proc.stdout.strip() if proc.returncode == 0 else ""
    return dict(sorted(out.items()))


def build_record(args, script: Path, tree_digest: str) -> dict:
    """The provenance record of one source build, written beside the pin marker.

    The record replaces the index hash that a source build cannot carry. The
    source names the URL and the full commit of a git build, or the tree hash
    of the folder copy. No credential enters it: the token of a private source
    reaches the clone command of the session alone, and nothing here reads the
    environment for it.
    """
    if args.git_url:
        source = {"url": args.git_url, "commit": args.commit or ""}
    else:
        source = {"tree_hash": tree_digest}
    if args.package_dir:
        source["package_dir"] = args.package_dir
    return {
        "schema": 1,
        "source": source,
        "images": {
            "provisioner": os.environ.get(PROVISIONER_DIGEST_ENV, ""),
            "base": os.environ.get(BASE_DIGEST_ENV, ""),
        },
        "apt": {
            "snapshot_date": args.apt_snapshot_date or "",
            "packages": apt_versions(list(args.apt_package)),
        },
        "tools": tool_versions(),
        "script": script.read_text(),
        "script_sha256": script_sha256(script),
        "arch": arch(),
    }


def source_qualifier(args, tree_digest: str) -> str:
    """`@git:<full sha>` for a git source, `@tree:<sha16>` for a folder."""
    if args.git_url:
        if not args.commit:
            raise SourceBuildError(
                "a git source names its full commit sha — the pin qualifier and "
                "the build record read it, and the plan resolved it")
        return f"@git:{args.commit}"
    return f"@tree:{tree_digest[:16]}"


def root_artifact(out: Path) -> tuple[str, Path]:
    """The one root artifact the script built, and its track.

    The script contract: exactly one installed R package directory (its
    DESCRIPTION names it) or exactly one built wheel, and nothing else in the
    output directory. A second entry — a wheel beside the root, or a
    dependency the script installed itself — refuses the run, because the
    dependencies belong to the hash-pinned paths and the root is the only
    thing the record proves.
    """
    entries = sorted(p for p in out.iterdir()) if out.is_dir() else []
    if not entries:
        raise SourceBuildError(
            f"the build script left no artifact in {out}: the script must build "
            f"exactly one root artifact — an installed R package directory or a "
            f"built wheel — into the output directory")
    if len(entries) > 1:
        names = ", ".join(e.name for e in entries)
        raise SourceBuildError(
            f"the output directory {out} holds more than the one root artifact "
            f"({names}): the script must install no dependencies, because "
            f"acquire-source resolves and installs them itself through the "
            f"hash-pinned paths")
    entry = entries[0]
    if entry.is_dir() and (entry / "DESCRIPTION").is_file():
        return "r", entry
    if entry.is_file() and entry.name.endswith(".whl"):
        return "python", entry
    raise SourceBuildError(
        f"{entry} is neither an installed R package directory (no DESCRIPTION) "
        f"nor a built wheel, thus the run cannot store it")


def store_r_root(artifact: Path, qualifier: str, record: dict) -> tuple[Path, str, str, bool]:
    """(store directory, pin, name) of a source-built R root.

    The name and the version come from the DESCRIPTION of the artifact, never
    from the repository or the script.
    """
    name, _version = read_r_pkg(artifact)
    store_dir, is_new = store_r_package(artifact, qualifier=qualifier, record=record)
    pin = (store_dir / name / PIN_MARKER).read_text().strip()
    return store_dir, pin, name, is_new


def wheel_identity(staged: Path) -> tuple[str, str]:
    """(name, version) of the staged root, from its .dist-info.

    The metadata is the authority — never the wheel file name, which a build
    step can spell its own way, and never the repository name.
    """
    infos = sorted(p for p in staged.iterdir()
                   if p.is_dir() and p.name.endswith(".dist-info"))
    if not infos:
        raise SourceBuildError(
            f"the installed root of {staged} carries no .dist-info directory, "
            f"thus its name and version cannot be read")
    name = version = None
    for line in (infos[0] / "METADATA").read_text(errors="replace").splitlines():
        if line.startswith("Name:"):
            name = line.split(":", 1)[1].strip()
        elif line.startswith("Version:"):
            version = line.split(":", 1)[1].strip()
        if name and version:
            break
    if not name or not version:
        stem = infos[0].name[:-len(".dist-info")]
        name, _, version = stem.rpartition("-")
    if not name or not version:
        raise SourceBuildError(
            f"the .dist-info of {staged} names no Name and Version, thus the "
            f"identity of the source-built root cannot be read")
    return name, version


def root_requirements(staged: Path) -> list[str]:
    """The Requires-Dist lines of the staged root, markers included.

    The requirements ride to the resolver as they are: uv reads each marker
    against the same interpreter the sandbox runs, thus a false marker drops
    at the resolve and never installs.
    """
    info = next((p for p in sorted(staged.iterdir())
                 if p.is_dir() and p.name.endswith(".dist-info")), None)
    if info is None:
        return []
    return [line.split(":", 1)[1].strip()
            for line in (info / "METADATA").read_text(errors="replace").splitlines()
            if line.startswith("Requires-Dist:")]


def stage_python_root(wheel: Path) -> Path:
    """Install the built wheel into a private staging tree with no
    dependencies, and give the tree back.

    The staging holds the installed root whose `.dist-info` names the identity
    and the requirements. The publish step — the markers, the build record,
    and the move into the pool — runs AFTER the dependency installs, so the
    record's apt block reads dpkg at its final state.
    """
    staging = staging_dir("python") / "source-root"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    log(f"installing the source-built root from {wheel.name}")
    proc = subprocess.run(
        ["uv", "pip", "install", "--python", PYTHON, "--no-deps", "--no-cache",
         "--break-system-packages", "--target", str(staging), str(wheel)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SourceBuildError(
            f"uv could not install the built wheel {wheel.name} (exit {proc.returncode}).\n"
            f"{proc.stderr.strip() or '(uv wrote nothing to stderr)'}")
    return staging


def publish_python_root(staging: Path, name: str, version: str, qualifier: str, record: dict) -> tuple[Path, str, bool]:
    """(store directory, is_new) of a staged source-built Python root.

    The root installs from the built wheel with no index hash — no index
    served it — under `--no-deps`, because acquire-source resolves and installs
    the dependencies itself through the hash-pinned index path.
    """
    identity = python_identity(name)
    pin = f"{name}=={version}{qualifier}"
    existing = find_stored(pin, "python")
    if existing is not None:
        return existing, False
    digest = tree_hash(staging)
    final = STORE / f"{address(identity)}-{version}-{digest[:16]}"
    if final.exists():
        return final, False
    (staging / PIN_MARKER).write_text(pin + "\n")
    (staging / HASH_MARKER).write_text(digest + "\n")
    (staging / BUILD_MARKER).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    subprocess.run(["chmod", "-R", "a+rX", str(staging)], check=True)
    final, is_new = _publish_store_dir(staging, final)
    return final, is_new


def source_r_dependencies(tree: Path, root_name: str) -> tuple[list[tuple[Path, str, bool]], Path]:
    """The store directories of the dependency closure of a source-built R root,
    beside the staged library that holds them loadable.

    pak resolves the package tree (the snapshot root, or the package directory
    inside it), whose DESCRIPTION names the dependencies,
    and the entries the pool does not hold install into a private staging
    library through the same lockfile path an index acquisition uses. The root
    itself never installs here: its provenance is the build record, not the
    pak lock, and its bytes come from the output artifact. The root's own
    name leaves the entry list ENTIRELY — an index build of the same name in
    the pool must join no stage, because the root is the one package whose
    provenance this run replaces.

    The staging library STAYS ALIVE for the script as links to the pool
    packages: `store_r_package` moves a fresh install out of the staging tree,
    and the clean run mounts no farm, thus nothing else puts these
    dependencies on R's library path while `R CMD INSTALL` loads the root's
    imports. The links are relative, because the script reads the library
    through the read-only view of the store, where the absolute store path does
    not exist. The caller removes the library once the script and the record
    are done.
    """
    lock_out = run_temp("pak-lock-source.json")
    proc = subprocess.run(
        ["Rscript", "/usr/local/bin/acquire_r.R", "resolve", str(tree), str(lock_out)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SourceBuildError(
            f"pak could not resolve the dependency closure of {tree}.\n"
            f"{proc.stderr.strip() or '(pak wrote nothing to stderr)'}")
    pak_lock = json.loads(lock_out.read_text())
    entries = [
        {"name": p["package"], "version": p["version"]}
        for p in pak_lock.get("packages", [])
        if isinstance(p, dict) and p.get("package") and p.get("version")
        and p["package"] != root_name
    ]
    staging = staging_dir("r") / "source"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    needed = {e["name"] for e in entries
              if find_stored(f"{e['name']}=={e['version']}", "r") is None}
    if needed:
        filtered = dict(pak_lock)
        filtered["packages"] = [p for p in pak_lock.get("packages", [])
                                if isinstance(p, dict) and p.get("package") in needed]
        filtered_path = run_temp("pak-lock-source-needed.json")
        filtered_path.write_text(json.dumps(filtered) + "\n")
        proc = subprocess.run(
            ["Rscript", "/usr/local/bin/acquire_r.R", "install",
             str(filtered_path), str(staging)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            shutil.rmtree(staging, ignore_errors=True)
            raise SourceBuildError(
                f"pak could not install the resolved dependencies of the source "
                f"tree.\n{proc.stderr.strip() or '(pak wrote nothing to stderr)'}")

    stored: list[tuple[Path, str, bool]] = []
    seen: set[Path] = set()
    for pkg_dir in sorted(p for p in staging.iterdir() if (p / "DESCRIPTION").is_file()):
        name, version = read_r_pkg(pkg_dir)
        store_dir, is_new = store_r_package(pkg_dir)
        if store_dir in seen:
            continue
        seen.add(store_dir)
        stored.append((store_dir, f"{name}=={version}", is_new))
    for entry in entries:
        hit = find_stored(f"{entry['name']}=={entry['version']}", "r")
        if hit is not None and hit not in seen:
            seen.add(hit)
            stored.append((hit, f"{entry['name']}=={entry['version']}", False))
    for store_dir, pin, _is_new in stored:
        name = pin.split("==", 1)[0]
        link = staging / name
        if not link.exists():
            link.symlink_to(os.path.relpath(store_dir / name, staging))
    return stored, staging


def source_python_dependencies(root_dir: Path, stored: list[tuple[Path, str, bool]]) -> None:
    """Install the dependency closure of a source-built root, and append each
    store directory to `stored` as it lands.

    The requirements come from the wheel the script built — the published
    store directory holds the same metadata — and every pin installs through
    the hash-enforced index path: a source build trades the hash of its root
    for the record, never the hashes of its dependencies. The caller owns
    `stored`, thus a refusal in the middle of the loop still frees the
    directories that earlier pins made.
    """
    requirements = root_requirements(root_dir)
    if not requirements:
        return
    try:
        constraints = _pool_constraints()
        if constraints is None:
            pins = resolve(requirements)
        else:
            try:
                pins = resolve(requirements, constraints)
            except ResolveError:
                log("the held pins conflict with the source requirements; resolving fresh")
                pins = resolve(requirements)
    except ResolveError as exc:
        raise SourceBuildError(str(exc)) from exc
    for pin in pins:
        try:
            path, is_new = ensure_stored(pin, pins[pin])
        except (ResolveError, SystemExit) as exc:
            raise SourceBuildError(str(exc)) from exc
        stored.append((path, pin, is_new))


def refuse_dangling_edges(nodes: dict) -> None:
    """Refuse an edge of the staged set that names no pool package and no
    image-owned name.

    `collect` keeps such an edge under its bare name. The published graph
    counts as a target too, because an edge into a pool package the run reused
    resolves there and not inside the staged set.
    """
    published: dict = {}
    deps_path = LIBS / emit_deps.GRAPH_NAME
    if deps_path.is_file():
        with contextlib.suppress(OSError, ValueError):
            published = json.loads(deps_path.read_text()).get("nodes", {})
    bad = [(key, edge) for key, node in sorted(nodes.items())
           for edge in node.get("edges", [])
           if edge not in nodes and edge not in published]
    if not bad:
        return
    lines = "\n".join(f"  {key} -> {edge}" for key, edge in bad)
    raise SourceBuildError(
        f"{len(bad)} dependency edge(s) of the source build name no pool package "
        f"and no image-owned package, thus the graph would hold a dangling "
        f"edge:\n{lines}")


def package_tree(snapshot: Path, package_dir: str | None) -> Path:
    """The tree pak resolves: the snapshot root, or the package directory
    inside it. A package directory that leaves the snapshot, or that holds no
    DESCRIPTION, refuses the run."""
    if not package_dir:
        return snapshot
    given = Path(package_dir)
    if given.is_absolute() or ".." in given.parts:
        raise SourceBuildError(
            f"the package directory {package_dir!r} must be relative to the snapshot, with no `..` segment")
    tree = snapshot / given
    description = tree / "DESCRIPTION"
    real_root = snapshot.resolve()
    if not tree.resolve().is_relative_to(real_root) or not description.resolve().is_relative_to(real_root):
        raise SourceBuildError(
            f"the package directory {package_dir!r} resolves outside the snapshot")
    if not description.is_file():
        raise SourceBuildError(
            f"the package directory {package_dir!r} holds no DESCRIPTION")
    return tree


def cmd_acquire_source(args) -> int:
    """Run one clean source build: the apt pin and install, the dependency
    resolve in the track's order, the unprivileged script, the pool writes,
    the staged nodes, and the build record.

    The two-phase contract of `acquire` holds here too: the pool and the report
    are the only writes, deps.json and every farm stay untouched, and the host
    commits the staged nodes only after the load check passes inside the
    sandbox image. A failed check leaves no advertised state, and reclaim
    frees the orphaned bytes.
    """
    global RUN_TOKEN
    RUN_TOKEN = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"

    snapshot = Path(args.snapshot)
    script = Path(args.script)
    with store_lock(shared=True):
        STORE.mkdir(parents=True, exist_ok=True)
        nodes: dict = {}
        # The dependencies an R tree installs before its script; a refusal of
        # the run removes the store directories this run created from it.
        stored: list[tuple[Path, str, bool]] = []
        # The root this run published before the graph check: a refusal frees
        # it beside the dependency closure, so the pool holds no orphan.
        published: list[tuple[Path, bool]] = []
        try:
            if not snapshot.is_dir():
                raise SourceBuildError(f"the pristine source snapshot {snapshot} is absent")
            if not script.is_file():
                raise SourceBuildError(f"the approved build script {script} is absent")
            # Each refusal that needs no work comes before the first install.
            tree = package_tree(snapshot, args.package_dir)
            refuse_bad_apt_names(list(args.apt_package))
            store_parent()
            # The apt sources pin to the dated snapshot BEFORE anything runs,
            # because the apt install of the run obeys the pin.
            if args.apt_snapshot_date:
                pin_apt_sources(args.apt_snapshot_date)
            install_apt_packages(list(args.apt_package))
            # The folder hash reads the pristine copy before the script runs,
            # because a build can write into its own source tree and the record
            # must hold the tree the session approved.
            tree_digest = "" if args.git_url else tree_hash(snapshot)
            qualifier = source_qualifier(args, tree_digest)
            # The dependency order follows the track. An R tree resolves and
            # installs its dependencies BEFORE the script, because `R CMD
            # INSTALL` refuses a package whose imports are absent; a Python
            # tree builds the wheel first (a wheel build needs no runtime
            # dependencies) and resolves the wheel's requirements after.
            r_library: Path | None = None
            if (tree / "DESCRIPTION").is_file():
                root_name, _version = read_r_pkg(tree)
                stored, r_library = source_r_dependencies(tree, root_name)
            # The script's `R CMD INSTALL` loads the root's imports from the
            # staged library alone: no farm is mounted here, thus no other
            # copy of a dependency sits on R's library path.
            run_build_script(snapshot, script, Path(args.output), r_library, args.lib_view)
            # The record is built AFTER the script and the dependency installs,
            # because dpkg then holds the versions the plan's apt packages
            # resolved to, and the record states what installed, not what a
            # plan named.
            track, artifact = root_artifact(Path(args.output))
            if track == "r":
                record = build_record(args, script, tree_digest)
                root_dir, pin, name, root_new = store_r_root(artifact, qualifier, record)
                published.append((root_dir, root_new))
            else:
                staging = stage_python_root(artifact)
                name, version = wheel_identity(staging)
                source_python_dependencies(staging, stored)
                record = build_record(args, script, tree_digest)
                pin = f"{name}=={version}{qualifier}"
                root_dir, root_new = publish_python_root(staging, name, version, qualifier, record)
                published.append((root_dir, root_new))
            entries = [(root_dir, pin, root_new), *stored]
            unique_dirs = sorted({d for d, _pin, _new in entries}, key=lambda d: d.name)
            nodes = emit_deps.collect(unique_dirs)
            refuse_dangling_edges(nodes)
            outcome = {
                "outcome": "source",
                "spec": f"{track}:{pin}",
                "ecosystem": track,
                "pin": pin,
                "name": name,
                "store_dir": root_dir.name,
                "installed": [pin for _d, pin, new in entries if new],
                "reused": [pin for _d, pin, new in entries if not new],
                "store_dirs": [d.name for d in unique_dirs],
            }
        except SourceBuildError as exc:
            nodes = {}
            outcome = {"outcome": "refused", "reason": str(exc)}
            for store_dir, _pin, created in stored:
                if created:
                    shutil.rmtree(store_dir, ignore_errors=True)
            for store_dir, created in published:
                if created:
                    shutil.rmtree(store_dir, ignore_errors=True)
        shutil.rmtree(staging_dir("python"), ignore_errors=True)
        shutil.rmtree(staging_dir("r"), ignore_errors=True)

        report = {
            "schema": 1,
            "arch": arch(),
            "outcomes": [outcome],
            "nodes": nodes,
        }
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        temp = report_path.with_suffix(report_path.suffix + ".tmp")
        temp.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        os.replace(temp, report_path)

    if outcome["outcome"] == "source":
        log(f"acquire-source: {outcome['pin']} built and staged ({len(outcome['store_dirs'])} "
            f"store dir(s)); report at {args.report}; deps.json untouched — the host "
            f"commits after the load check")
    else:
        log(f"acquire-source: refused — {outcome['reason']}")
    return 0


# --- build ---------------------------------------------------------------------


def load_manifest(path: Path) -> dict:
    import yaml
    manifest = yaml.safe_load(path.read_text()) or {}
    if not isinstance(manifest, dict):
        raise SystemExit(f"[provision] the manifest {path} is not a mapping")
    return manifest


def manifest_python_specs(manifest: dict) -> list[dict]:
    """The python entries of the manifest: name, optional constraint, warm path.

    The section is `python.pip.{common,<arch>}`. An entry is a bare string —
    a name with an optional inline constraint — or an object with `name`,
    `version`, and `warm`.
    """
    pip = (manifest.get("python") or {}).get("pip") or {}
    entries = []
    for raw in list(pip.get("common") or []) + list(pip.get(arch()) or []):
        if isinstance(raw, str):
            match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._\[\],-]*)(.*)$", raw.strip())
            if match:
                entries.append({"name": match.group(1), "constraint": match.group(2).strip(), "warm": None})
        elif isinstance(raw, dict) and raw.get("name"):
            entries.append({"name": str(raw["name"]),
                            "constraint": str(raw.get("version") or ""),
                            "warm": raw.get("warm")})
    return entries


def manifest_r_names(manifest: dict) -> dict[str, list[str]]:
    """The R entry names of the manifest, per subtree."""
    r = manifest.get("r") or {}
    out: dict[str, list[str]] = {}
    for key in ("cran", "bioconductor", "git", "github"):
        names = []
        for raw in r.get(key) or []:
            if isinstance(raw, str):
                names.append(raw)
            elif isinstance(raw, dict) and raw.get("name"):
                names.append(str(raw["name"]))
        out[key] = names
    return out


def read_committed_lock(path: Path | None) -> dict:
    if path is None or not path.is_file():
        return {"schema": 1, "entries": {}, "roots": {}, "pins": {}}
    try:
        lock = json.loads(path.read_text())
    except (OSError, ValueError):
        return {"schema": 1, "entries": {}, "roots": {}, "pins": {}}
    if lock.get("schema") != 1:
        return {"schema": 1, "entries": {}, "roots": {}, "pins": {}}
    return lock


def resolve_manifest_python(entries: list[dict], committed: dict) -> dict[str, list[str]]:
    """Resolve the manifest python track, with the committed lock second.

    The model is `npm install` with a committed lock: an entry whose manifest
    constraint still matches resolves from the lock, and a changed entry
    resolves fresh. The unchanged pins ride in a constraints file, thus uv
    keeps them while the changed entries re-resolve around them. When the
    constrained resolve conflicts, the run drops the constraints and resolves
    fresh, and the workflow commits the new lock back.
    """
    specs = [e["name"] + e["constraint"] for e in entries]
    unchanged_pins: list[str] = []
    for entry in entries:
        recorded = committed.get("entries", {}).get(python_identity(entry["name"]).name)
        if recorded == entry["constraint"]:
            root_pin = committed.get("roots", {}).get(python_identity(entry["name"]).name)
            if root_pin:
                unchanged_pins.append(root_pin)
    constraints: Path | None = None
    if unchanged_pins:
        constraints = run_temp("constraints.txt")
        constraints.write_text("\n".join(unchanged_pins) + "\n")
    try:
        return resolve(specs, constraints)
    except ResolveError:
        if constraints is None:
            raise
        log("the committed lock conflicts with the manifest; resolving fresh")
        return resolve(specs)


def committed_lock_of(entries: list[dict], pins: dict[str, list[str]]) -> dict:
    """The per-arch committed lock that the workflow writes back."""
    roots: dict[str, str] = {}
    by_name = {pin.split("==", 1)[0]: pin for pin in pins}
    for entry in entries:
        pin = by_name.get(python_identity(entry["name"]).name)
        if pin:
            roots[python_identity(entry["name"]).name] = pin
    return {
        "schema": 1,
        "arch": arch(),
        "entries": {python_identity(e["name"]).name: e["constraint"] for e in entries},
        "roots": roots,
        "pins": pins,
    }


def cmd_build(args) -> int:
    """Build the catalog farm from the manifest, and publish it atomically.

    The staging farm assembles beside the farms. Its `inflexa.lock` writes
    LAST, thus a crash leaves no staging that the mount gate accepts. The
    swap publishes the complete farm, and the graph appends after the swap.
    """
    global RUN_TOKEN
    RUN_TOKEN = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"

    manifest_path = Path(args.manifest)
    manifest = load_manifest(manifest_path)
    r_names = manifest_r_names(manifest)
    # Refuse before any track runs: an anonymous run works for the first
    # calls and dies an hour later, thus the late failure wastes the bulk.
    if r_names["github"] and not os.environ.get("GITHUB_PAT"):
        raise SystemExit(
            "[provision] the manifest names a github entry and GITHUB_PAT is not set. "
            "An anonymous run caps at 60 GitHub API calls per hour and fails late with 403. "
            "Set GITHUB_PAT, then run the build again.")
    entries = manifest_python_specs(manifest)
    committed = read_committed_lock(Path(args.lock) if args.lock else None)

    with store_lock(shared=True):
        STORE.mkdir(parents=True, exist_ok=True)
        FARMS.mkdir(parents=True, exist_ok=True)
        recover_farm(args.farm)
        farm = FARMS / args.farm
        staging = FARMS / (FARM_STAGING + args.farm)
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True)

        # The python track.
        packages: list[dict] = []
        conflicts: list[dict] = []
        pins: dict[str, list[str]] = {}
        if entries:
            pins = resolve_manifest_python(entries, committed)
            requested_names = {python_identity(e["name"]).name for e in entries}
            store_dirs: list[Path] = []
            added = 0
            for pin in pins:
                path, is_new = ensure_stored(pin, pins[pin])
                store_dirs.append(path)
                added += 1 if is_new else 0
            log(f"{added} newly installed, {len(pins) - added} reused from the pool")
            shutil.rmtree(staging_dir("python"), ignore_errors=True)
            conflicts = build_python_track(staging, store_dirs)
            for store_dir in store_dirs:
                pin = (store_dir / PIN_MARKER).read_text().strip()
                packages.append(lock_package_entry(
                    store_dir, "python", python_identity(pin.split("==", 1)[0]).name in requested_names))

        # The R tracks, through pak (gen-r-lock.R): CRAN + Bioconductor + the
        # catalog-only git track resolve as one lockfile, and GitHub installs
        # incrementally on top, also through pak — remotes cannot read the
        # `RemoteType: bioc` metadata that the pak bulk writes.
        r_language: dict | None = None
        if any(r_names.values()):
            stage_root = staging_dir("r")
            if stage_root.exists():
                shutil.rmtree(stage_root)
            stage_root.mkdir(parents=True)
            log("R bulk: resolving + installing via pak (gen-r-lock.R)")
            subprocess.run(["Rscript", "/usr/local/bin/gen-r-lock.R",
                            str(manifest_path), str(stage_root)], check=True)
            for repo in r_names["github"]:
                github_lib = stage_root / "r" / "github"
                github_lib.mkdir(parents=True, exist_ok=True)
                log(f"R github: installing {repo} through pak (incremental, best-effort)")
                # The bulk libraries ride in .libPaths for the resolve, but
                # pak installs every dependency of the repository into `lib`,
                # even one that the bulk libraries already hold: pkg_install
                # reads "installed" from that one library alone. The
                # reinstall lands on the same bytes, and stage_r_subtrees
                # records the directory once.
                rexpr = (
                    f".libPaths(c('{github_lib}', '{stage_root}/r/bioconductor', "
                    f"'{stage_root}/r/cran', .libPaths())); "
                    f"pak::pkg_install('{repo}', lib='{github_lib}', upgrade=FALSE)"
                )
                if subprocess.run(["R", "-q", "-e", rexpr]).returncode != 0:
                    # A pinned CDN edge can sour mid-run. The second attempt
                    # reuses the pak cache, thus a transient heals cheaply.
                    log(f"github install of {repo} failed; one more attempt")
                    if subprocess.run(["R", "-q", "-e", rexpr]).returncode != 0:
                        log(f"WARNING: github install of {repo} did not finish cleanly; keeping what installed")

            stored, r_packages = stage_r_subtrees(stage_root, r_names)
            packages.extend(r_packages)

            old_lock_data: dict = {}
            if (farm / "inflexa.lock").is_file():
                with contextlib.suppress(OSError, ValueError):
                    old_lock_data = json.loads((farm / "inflexa.lock").read_text())
            graph_data: dict = {}
            if (LIBS / "deps.json").is_file():
                with contextlib.suppress(OSError, ValueError):
                    graph_data = json.loads((LIBS / "deps.json").read_text())
            for sub, name, store_dir, requested in carry_held_r_entries(
                    old_lock_data, stored, r_names, graph_data):
                stored[sub].append((name, store_dir))
                packages.append(lock_package_entry(store_dir, sub, requested))
                log(f"kept the held {sub}/{name} from the pool; the install failed this round")
            build_r_track(staging, stored)

            pak_lock: dict = {}
            bulk_lock = stage_root / "r" / "r-bulk.lock"
            if bulk_lock.is_file():
                with contextlib.suppress(OSError, ValueError):
                    pak_lock = json.loads(bulk_lock.read_text())
            shutil.rmtree(stage_root, ignore_errors=True)
            r_language = {
                "version": str(manifest.get("r_version") or r_runtime_version()),
                "bioc_releases": bioc_releases(pak_lock),
                "pak_lock": pak_lock,
            }

        languages: dict = {}
        if entries:
            languages["python"] = {"version": python_runtime_version(), "index": INDEX_URL}
        if r_language is not None:
            languages["r"] = r_language

        lock = {
            "schema": LOCK_SCHEMA,
            "arch": arch(),
            "packages": sorted(packages, key=lambda p: (p["track"], p["name"].lower())),
            "languages": languages,
            "merge_conflicts": conflicts,
        }

        with commit_lock():
            # The mode goes on before the lock, thus the lock write stays the
            # last write inside the staging.
            subprocess.run(["chmod", "-R", "a+rX", str(staging)], check=True)
            write_farm_lock(staging, lock)
            publish_farm(staging, farm)
            emit_deps.append_for_farm(LIBS, farm)

        if args.lock and pins:
            lock_path = Path(args.lock)
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            lock_path.write_text(json.dumps(committed_lock_of(entries, pins),
                                            indent=2, sort_keys=True) + "\n")
            log(f"committed lock written to {args.lock}")

    log(f"farm '{args.farm}' ready: {len(packages)} package(s)")
    return 0


# --- prepare -------------------------------------------------------------------

# The two prepared caches, by the directory name that each carries in a farm.
NUMBA_CACHE = "numba-cache"
MPL_CACHE = "matplotlib_config"

# numba names each cache data file after the function and the absolute
# directory of its source. NUMBA_DEBUG_CACHE reports each file it loads or
# saves, and the cache check parses the same two lines.
CACHE_EVENT = re.compile(r"\[cache\] data (loaded from|saved to) ['\"](.+?)['\"]")


def cache_entry_key(path: str, root: Path) -> str:
    """The portable name of one numba cache data file — relative to the cache root."""
    rel = os.path.relpath(path, root)
    return path if rel.startswith("..") else rel


def script_sha256(script: Path) -> str:
    return hashlib.sha256(script.read_bytes()).hexdigest()


def cmd_prepare(args) -> int:
    """Run the warm script of each manifest entry that names one.

    The run works against the catalog farm that an earlier `build` published.
    The invoker binds that farm at /mnt/libs/farm, read-write, nested inside
    the store-root bind, because a numba cache key holds the source path that
    the sandbox imports from. The prepared caches land inside the farm — the
    entrypoint of the sandbox seeds from them — and the run records the cache
    entries per package in the farm lock.

    An acquisition never warms: a numba entry keys on a call signature, and
    only a workload that a person wrote supplies one.
    """
    manifest_path = Path(args.manifest)
    manifest = load_manifest(manifest_path)
    warm_entries = [(e["name"], manifest_path.parent / str(e["warm"]))
                    for e in manifest_python_specs(manifest) if e.get("warm")]
    if not warm_entries:
        log("prepare: no manifest entry names a warm script")
        return 0

    with store_lock(shared=True):
        farm = FARMS / args.farm
        lock_path = farm / LOCK_NAME
        if not lock_path.is_file():
            raise SystemExit(
                f"[provision] no farm to prepare at {farm}. A preparation run warms the "
                f"farm that an earlier build published, thus build the farm first.")

        # A bind mount is not a symlink, thus no path comparison can tell that
        # the bind resolves this farm. Write a probe into the farm, and read
        # it through the bind.
        probe = farm / f".inflexa-bind-probe-{uuid.uuid4().hex}"
        try:
            probe.write_text("probe\n")
            resolved = (FARM_BIND / probe.name).is_file()
        finally:
            probe.unlink(missing_ok=True)
        if not resolved:
            raise SystemExit(
                f"[provision] the preparation run cannot resolve the farm at {FARM_BIND}. "
                f"The invoker must bind {farm} there, read-write, nested inside the "
                f"store-root bind. A numba cache key holds the source path that the "
                f"sandbox imports from, thus a cache written through any other path "
                f"never loads.")

        env = dict(os.environ)
        env["PYTHONPATH"] = str(FARM_BIND / "python" / "site-packages")
        env["MPLCONFIGDIR"] = str(farm / MPL_CACHE)
        env["NUMBA_CACHE_DIR"] = str(farm / NUMBA_CACHE)
        if os.uname().machine == "aarch64":
            # Autodetection of the host CPU crashes LLVM codegen on newer
            # arm64 cores. The sandbox sets the identical value.
            env["NUMBA_CPU_NAME"] = "generic"
        Path(env["MPLCONFIGDIR"]).mkdir(parents=True, exist_ok=True)
        Path(env["NUMBA_CACHE_DIR"]).mkdir(parents=True, exist_ok=True)
        cache_root = Path(env["NUMBA_CACHE_DIR"])

        def child(script: Path, environment: dict[str, str]) -> subprocess.CompletedProcess:
            # -P keeps the script directory off sys.path. A warm script carries the
            # name of the package it warms, and without the flag `import matplotlib`
            # inside warm/matplotlib.py imports the script itself.
            proc = subprocess.run([PYTHON, "-P", str(script)], env=environment,
                                  capture_output=True, text=True)
            if proc.returncode != 0:
                tail = (proc.stderr or "").strip().splitlines()[-8:]
                detail = "\n  ".join(tail) if tail else "(the child wrote nothing to stderr)"
                raise SystemExit(
                    f"[provision] the warm script {script} exited non-zero "
                    f"(exit {proc.returncode}). A script that cannot run is a broken "
                    f"catalog:\n  {detail}")
            return proc

        # Two passes per package. The first pass compiles and saves. The
        # second pass, with the cache debug on, reports which entry a later
        # run of the same workload reuses — only those enter the record.
        warm_record: dict[str, dict] = {}
        debug_env = {**env, "NUMBA_DEBUG_CACHE": "1"}
        for name, script in warm_entries:
            if not script.is_file():
                raise SystemExit(f"[provision] the warm script of {name} is absent: {script}")
            started = time.monotonic()
            child(script, env)
            log(f"  warm {name}: ok in {time.monotonic() - started:.1f}s")
            proc = child(script, debug_env)
            prepared: set[str] = set()
            rewritten: set[str] = set()
            for event, path in CACHE_EVENT.findall(proc.stdout + proc.stderr):
                key = cache_entry_key(path, cache_root)
                (prepared if event == "loaded from" else rewritten).add(key)
            for key in sorted(rewritten - prepared):
                log(f"    no run reuses {key} (workload of {name})")
            warm_record[name] = {
                # The manifest-relative path of the script, thus the cache
                # check finds the same bytes from its own mount of the
                # manifest directory.
                "script": str(script.relative_to(manifest_path.parent)),
                "script_sha256": script_sha256(script),
                "cache_entries": sorted(prepared),
            }

        with commit_lock():
            lock = json.loads(lock_path.read_text())
            lock["warm"] = warm_record
            write_farm_lock(farm, lock)
            subprocess.run(["chmod", "-R", "a+rX", str(farm)], check=True)

    total = sum(len(record["cache_entries"]) for record in warm_record.values())
    log(f"farm '{args.farm}' prepared: {len(warm_record)} package(s), {total} cache entry(s) recorded")
    return 0


# --- main ----------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Provision packages into the package store.",
        epilog="The invoker binds the store root read-write at /mnt/libs. "
               "A prepare run needs a second bind: the catalog farm at "
               "/mnt/libs/farm, read-write, nested inside the store-root bind.")
    sub = ap.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="resolve the manifest and build the catalog farm")
    build.add_argument("--manifest", required=True, help="path to the package-store manifest")
    build.add_argument("--lock", default=None,
                       help="path to the committed per-arch lock; read for unchanged pins, written back after the resolve")
    build.add_argument("--farm", default="catalog", help="the farm to build (default: catalog)")
    build.set_defaults(func=cmd_build)

    acquire = sub.add_parser("acquire", help="install a spec set into the pool and stage the graph nodes")
    acquire.add_argument("--report", required=True,
                         help="path of the report file: one outcome per spec, plus the staged graph nodes")
    acquire.add_argument("specs", nargs="+",
                         help="package requests; the internal form python:<spec> / r:<spec> names the ecosystem")
    acquire.set_defaults(func=cmd_acquire)

    acquire_source = sub.add_parser(
        "acquire-source",
        help="run the approved build script over a pristine source snapshot and store the root it builds")
    acquire_source.add_argument("--report", required=True,
                                help="path of the report file: the source outcome plus the staged graph nodes")
    acquire_source.add_argument("--snapshot", required=True,
                                help="the pristine source snapshot: a git work tree at the pinned commit, or a copy of a local folder")
    acquire_source.add_argument("--script", required=True,
                                help="the approved build script; it builds exactly one root artifact into the output "
                                     "directory and installs no dependencies")
    acquire_source.add_argument("--lib-view", required=True,
                                help="the path of the read-only view of the store root; the build script reads "
                                     "its R dependency library through it, because the script cannot reach /mnt/libs")
    acquire_source.add_argument("--package-dir", default=None,
                                help="the directory of the R package inside the snapshot, relative to the snapshot root; "
                                     "absent means the snapshot root")
    acquire_source.add_argument("--output", default=DEFAULT_BUILD_OUT,
                                help=f"the output directory of the root artifact (default: {DEFAULT_BUILD_OUT})")
    acquire_source.add_argument("--git-url", default=None,
                                help="the URL of the git source; absent means a local-folder source")
    acquire_source.add_argument("--commit", default=None,
                                help="the full commit sha of the git source, as the plan resolved it")
    acquire_source.add_argument("--apt-snapshot-date", default=None,
                                help="the timestamp of the Ubuntu snapshot the session's apt step used, as the image-creation time spells it (YYYYMMDDThhmmssZ)")
    acquire_source.add_argument("--apt-package", action="append", default=[], metavar="NAME",
                                help="an apt package the build installed; repeat for each one")
    acquire_source.set_defaults(func=cmd_acquire_source)

    prepare = sub.add_parser("prepare", help="run the per-package warm scripts against the catalog farm")
    prepare.add_argument("--manifest", required=True, help="path to the package-store manifest")
    prepare.add_argument("--farm", default="catalog", help="the farm to prepare (default: catalog)")
    prepare.set_defaults(func=cmd_prepare)

    reclaim = sub.add_parser("reclaim", help="remove store directories that no farm references")
    reclaim.add_argument("--debris", action="store_true",
                         help="remove only the directories with no farm link and no graph node, "
                              "plus the stale acquire and source-build reports; the graph stays untouched")
    reclaim.set_defaults(func=cmd_reclaim)

    remove_farm = sub.add_parser("remove-farm", help="remove one farm; the pool stays")
    remove_farm.add_argument("name", help="the farm to remove")
    remove_farm.set_defaults(func=cmd_remove_farm)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except OSError as exc:
        # A filesystem error — no space, a read-only store, a permission —
        # reaches here as a clean message and a non-zero exit. The staging
        # that the run left behind is unreachable, and the next run repairs it.
        name = errno.errorcode.get(exc.errno, "?") if exc.errno else "?"
        where = f": {exc.filename}" if exc.filename else ""
        sys.exit(f"[provision] a filesystem error stopped the run: "
                 f"{exc.strerror or exc} ({name}){where}")
