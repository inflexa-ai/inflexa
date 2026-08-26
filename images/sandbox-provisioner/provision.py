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

The entrypoint has five subcommands, one mode each. An impossible combination
is impossible by structure, because argparse accepts one subcommand:

  build       — the store build workflow. It resolves the manifest, builds the
                catalog farm, writes its `inflexa.lock` last, and publishes the
                farm by a crash-atomic staging swap.
  acquire     — the acquisition flights of the host. It installs a spec set
                into the pool, and it stages the graph nodes for the host
                commit. It writes no farm and it never touches deps.json.
  prepare     — the store build workflow. It runs the warm script of each
                manifest entry that names one, against the catalog farm, and
                it records the cache entries per package in the farm lock.
  reclaim     — the host reclamation command. It removes the store
                directories that no farm links and the graph does not
                advertise, under the exclusive lock.
  remove-farm — the analysis delete flow of the host. It removes one farm and
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
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import emit_deps

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

# Never part of a distribution's content and never farmed: `.lock` is uv's own
# per-target mutex. The markers are provisioner metadata, not installed
# content, thus they stay out of the content address too.
NOT_CONTENT = {PIN_MARKER, HASH_MARKER, R_LINKING_MARKER, ".lock"}

# Derived data that must not participate in the content address: warm-up
# writes numba artifacts and CPython bytecode into the tree AFTER the hash is
# taken, and an address that moved underneath them would defeat all reuse.
HASH_EXCLUDE_DIRS = {"__pycache__"}
HASH_EXCLUDE_SUFFIX = (".pyc", ".nbi", ".nbc")

# Acquisition runs are parallel, thus each run stages its installs under a
# name of its own. Outside a run the token is empty.
RUN_TOKEN = ""

# The two ecosystems that an acquire spec can name, as the internal prefix
# format `python:` / `r:`. The prefix never reaches a user surface — the host
# encodes the ecosystem into it where one is known.
ECOSYSTEMS = ("python", "r")

# The internal spec format of one acquire request.
SPEC_PREFIX = re.compile(r"^(python|r):(.+)$")


def log(msg: str) -> None:
    print(f"[provision] {msg}", flush=True)


def canon(name: str) -> str:
    """PEP 503 normalized distribution name."""
    return re.sub(r"[-_.]+", "-", name).lower()


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


def find_stored(pin: str) -> Path | None:
    """An existing store directory that holds exactly this pin."""
    name, version = pin.split("==", 1)
    for candidate in sorted(STORE.glob(f"{canon(name)}-{version}-*")):
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
    existing = find_stored(pin)
    if existing is not None:
        return existing, False

    name, version = pin.split("==", 1)
    if not hashes:
        raise SystemExit(f"[provision] refusing to install {pin} without a source hash")
    # Staged inside the store, not under /tmp: publishing is a rename, and a
    # rename is atomic within one filesystem only.
    staging = staging_dir("python") / canon(name)
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)

    frag = run_temp(f"req-{canon(name)}.txt")
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
    final = STORE / f"{canon(name)}-{version}-{digest[:16]}"
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


def store_r_package(pkg_dir: Path) -> tuple[Path, bool]:
    """Content-address an installed R package directory into the store.

    The store directory nests the package one level down, under its real
    package name: R rebuilds its own path as libname/packagename, and the
    nesting is what makes that resolve. renv's cache proves the layout.
    """
    name, version = read_r_pkg(pkg_dir)
    pin = f"{name}=={version}"
    existing = find_stored(pin)
    if existing is not None:
        return existing, False
    wrap = pkg_dir.parent / f".wrap-{pkg_dir.name}"
    if wrap.exists():
        shutil.rmtree(wrap)
    wrap.mkdir()
    pkg_dir.rename(wrap / name)
    inner = wrap / name
    digest = tree_hash(wrap)
    final = STORE / f"{canon(name)}-{version}-{digest[:16]}"
    if final.exists():
        shutil.rmtree(wrap)
        return final, False
    (inner / PIN_MARKER).write_text(pin + "\n")
    (inner / HASH_MARKER).write_text(digest + "\n")
    (inner / R_LINKING_MARKER).write_text(json.dumps(read_r_linking(inner)) + "\n")
    subprocess.run(["chmod", "-R", "a+rX", str(wrap)], check=True)
    return _publish_store_dir(wrap, final)


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
        if entry.get("requested"):
            name = entry["name"].lower()
            key = re.sub(r"[^a-z0-9]", "", name) if track == "github" else name
            if key not in wanted[track]:
                continue
            roots.append(entry)
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

    kept = roots + [entry for entry in deps if entry["store_dir"] in reachable]
    return [(entry["track"], entry["name"], STORE / entry["store_dir"],
             bool(entry.get("requested")))
            for entry in kept]


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

    With --debris the pass additionally removes the stale acquire reports,
    and it never rewrites the graph — the boot pass and the flush tail call
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
                for report in sorted(download.glob("acquire-*.json")):
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


def parse_spec(raw: str) -> dict:
    """One acquire spec: an optional internal ecosystem prefix, a name, one
    optional exact version. The prefix format never reaches a user surface."""
    ecosystem = None
    body = raw
    match = SPEC_PREFIX.match(raw)
    if match:
        ecosystem, body = match.group(1), match.group(2)
    name, _, version = body.partition("==")
    return {"raw": raw, "name": name.strip(), "version": version.strip() or None,
            "ecosystem": ecosystem}


def reject_off_index(spec: dict) -> str | None:
    """The refusal reason for a spec that names a location, or None.

    A direct URL, a VCS ref, or a local path bypasses the index and its
    hashes. Naming a package is permitted; naming a location is not. A
    slash-carrying request is a github or git form, and those tracks are
    catalog-only — the manifest carries them, and an acquisition refuses.
    """
    body = spec["name"]
    if "://" in spec["raw"] or body.startswith((".", "~")):
        return "a location is not a package request — name the package as a requirement"
    if body.endswith((".whl", ".tar.gz", ".zip")):
        return "an artifact file bypasses the pinned index and its hashes"
    if "/" in body:
        return "the github and git tracks are catalog-only — an acquisition covers CRAN, Bioconductor, and the Python index"
    return None


def python_index_holds(name: str) -> bool:
    """A presence probe of one name against the pinned Python index."""
    url = f"{INDEX_URL.rstrip('/')}/{canon(name)}/"
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


def acquire_python_spec(spec: dict) -> dict:
    """Acquire one Python spec: its own closure into the pool.

    Per-spec resolution is correct for a pool: the pool holds many versions,
    and a farm resolves one at link time. Two specs whose closures share a
    distribution converge on one store directory by content address, thus the
    shared dependency installs once. The resolve rides the pool pins as
    constraints, and a conflict drops them — refer to `_pool_constraints`.
    """
    requirement = spec["name"] + (f"=={spec['version']}" if spec["version"] else "")
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
        return {"spec": spec["raw"], "outcome": "refused", "reason": str(exc)}
    return {
        "spec": spec["raw"],
        "outcome": "acquired",
        "ecosystem": "python",
        "installed": installed,
        "reused": [p for p in pins if p not in installed],
        "store_dirs": [d.name for d in store_dirs],
    }


def acquire_r_spec(spec: dict) -> dict:
    """Acquire one R spec through pak, against CRAN and Bioconductor only.

    The resolve names the closure. An entry that the pool already holds at the
    resolved version links from the pool and never installs again — the
    needed subset alone installs, into a private staging library. The pak lock
    of the acquisition rides in the outcome as provenance.
    """
    ref = spec["name"] + (f"@{spec['version']}" if spec["version"] else "")
    lock_out = run_temp(f"pak-lock-{canon(spec['name'])}.json")
    proc = subprocess.run(
        ["Rscript", "/usr/local/bin/acquire_r.R", "resolve", ref, str(lock_out)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return {"spec": spec["raw"], "outcome": "refused",
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
                    if find_stored(f"{e['name']}=={e['version']}") is None}
    staging = staging_dir("r") / canon(spec["name"])
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    if needed_names:
        filtered = dict(pak_lock)
        filtered["packages"] = [p for p in pak_lock.get("packages", [])
                                if isinstance(p, dict) and p.get("package") in needed_names]
        filtered_path = run_temp(f"pak-lock-needed-{canon(spec['name'])}.json")
        filtered_path.write_text(json.dumps(filtered) + "\n")
        proc = subprocess.run(
            ["Rscript", "/usr/local/bin/acquire_r.R", "install", str(filtered_path), str(staging)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            shutil.rmtree(staging, ignore_errors=True)
            return {"spec": spec["raw"], "outcome": "refused",
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
        hit = find_stored(f"{entry['name']}=={entry['version']}")
        if hit is not None and hit not in store_dirs:
            store_dirs.append(hit)
    shutil.rmtree(staging, ignore_errors=True)

    return {
        "spec": spec["raw"],
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

    specs = [parse_spec(raw) for raw in args.specs]
    if not specs:
        log("acquire: no spec given")
        return 2

    with store_lock(shared=True):
        STORE.mkdir(parents=True, exist_ok=True)
        outcomes: list[dict] = []
        pending: list[dict] = []
        for spec in specs:
            reason = reject_off_index(spec)
            if reason is not None:
                outcomes.append({"spec": spec["raw"], "outcome": "refused", "reason": reason})
            else:
                pending.append(spec)

        # The both-hit stop. An unqualified name searches both ecosystems.
        # When both hold it, the run stops that spec with the two candidates,
        # and the host asks the user. A silent Python-first win is a fault.
        unqualified = [s for s in pending if s["ecosystem"] is None]
        r_presence = r_repos_hold([s["name"] for s in unqualified])
        ready: list[dict] = []
        for spec in pending:
            if spec["ecosystem"] is not None:
                ready.append(spec)
                continue
            in_python = python_index_holds(spec["name"])
            in_r = bool(r_presence.get(spec["name"], False))
            if in_python and in_r:
                outcomes.append({
                    "spec": spec["raw"],
                    "outcome": "both_hit",
                    "candidates": [
                        {"ecosystem": "python", "name": canon(spec["name"])},
                        {"ecosystem": "r", "name": spec["name"]},
                    ],
                })
            elif in_python:
                ready.append({**spec, "ecosystem": "python"})
            elif in_r:
                ready.append({**spec, "ecosystem": "r"})
            else:
                outcomes.append({"spec": spec["raw"], "outcome": "refused",
                                 "reason": "no ecosystem holds the name"})

        # One outcome per spec. A spec that cannot resolve drops out with its
        # own refusal, and the rest of the set still lands.
        acquired_dirs: list[Path] = []
        for spec in ready:
            outcome = acquire_python_spec(spec) if spec["ecosystem"] == "python" else acquire_r_spec(spec)
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
    log(f"acquire: {acquired}/{len(specs)} spec(s) acquired; report at {args.report}; "
        f"deps.json untouched — the host commits after the load check")
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
        recorded = committed.get("entries", {}).get(canon(entry["name"]))
        if recorded == entry["constraint"]:
            root_pin = committed.get("roots", {}).get(canon(entry["name"]))
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
        pin = by_name.get(canon(entry["name"]))
        if pin:
            roots[canon(entry["name"])] = pin
    return {
        "schema": 1,
        "arch": arch(),
        "entries": {canon(e["name"]): e["constraint"] for e in entries},
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
            requested_names = {canon(e["name"]) for e in entries}
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
                    store_dir, "python", canon(pin.split("==", 1)[0]) in requested_names))

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
                # The bulk libraries ride in .libPaths, thus pak reuses a
                # dependency that a range already satisfies and installs
                # only what the repository truly adds.
                rexpr = (
                    f".libPaths(c('{github_lib}', '{stage_root}/r/bioconductor', "
                    f"'{stage_root}/r/cran', .libPaths())); "
                    f"pak::pkg_install('{repo}', lib='{github_lib}', upgrade=FALSE)"
                )
                if subprocess.run(["R", "-q", "-e", rexpr]).returncode != 0:
                    log(f"WARNING: github install of {repo} did not finish cleanly; keeping what installed")

            requested_r = {name for names in r_names.values() for name in names}
            stored: dict[str, list[tuple[str, Path]]] = {sub: [] for sub in R_SUBTREES}
            for sub in R_SUBTREES:
                libdir = stage_root / "r" / sub
                if not libdir.is_dir():
                    continue
                for pkg_dir in sorted(p for p in libdir.iterdir() if (p / "DESCRIPTION").is_file()):
                    name, _version = read_r_pkg(pkg_dir)
                    store_dir, _is_new = store_r_package(pkg_dir)
                    stored[sub].append((name, store_dir))
                    packages.append(lock_package_entry(store_dir, sub, name in requested_r))

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

    prepare = sub.add_parser("prepare", help="run the per-package warm scripts against the catalog farm")
    prepare.add_argument("--manifest", required=True, help="path to the package-store manifest")
    prepare.add_argument("--farm", default="catalog", help="the farm to prepare (default: catalog)")
    prepare.set_defaults(func=cmd_prepare)

    reclaim = sub.add_parser("reclaim", help="remove store directories that no farm references")
    reclaim.add_argument("--debris", action="store_true",
                         help="remove only the directories with no farm link and no graph node, "
                              "plus the stale acquire reports; the graph stays untouched")
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
