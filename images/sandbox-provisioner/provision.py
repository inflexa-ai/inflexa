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

  /mnt/libs/deps.json
        The dependency graph of the store, one node for each store directory and
        each edge resolved. emit_deps.py writes it at the commit of a run.

The store carries NO active-farm pointer. A sandbox receives its own farm as a
second read-only bind at /mnt/libs/current, nested inside the store-root bind,
and the invoker of the container adds that bind. Thus two analyses resolve two
farms at the same time.

A run has two shapes. A run with --farm builds that farm, and the catalog build
is the one caller that needs it. A run with no --farm is an ACQUISITION run: it
resolves the specs, it installs them into the pool, and it appends the resolved
edges to the graph. It builds no farm, because each analysis composes its own
farm on the host, from the pool, with no container.

THE INVOKER CONTRACT OF A WARM RUN: a run that warms the caches must receive the
same bind. The invoker binds the target farm at /mnt/libs/current, read-write,
nested inside the store-root bind. A numba cache key holds the source path that
the sandbox imports from, thus a warm through any other path gives a cache that
the sandbox cannot load. A run that cannot resolve the farm at that path fails,
and it names the bind that it wants. Refer to warm().

A run that warms the caches builds no farm. A publish replaces the farm directory,
and the bind of the container then holds the directory that the publish
superseded. Thus the preparation of the caches is a run of its own: it names the
farm and the workload, and it passes no spec.

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
import uuid
from pathlib import Path

import emit_deps

LIBS = Path(os.environ.get("LIB_ROOT", "/mnt/libs"))
STORE = LIBS / "store"
FARMS = LIBS / "farms"

# The path the sandbox mounts the store at, read-only. The provisioner must see the
# store at this SAME path — the design's load-bearing detail — because a farm's
# symlinks bake it as an absolute target the sandbox has to resolve.
SANDBOX_MOUNT = Path(os.environ.get("SANDBOX_LIB_MOUNT", "/mnt/libs"))

# One lease file per sandbox that has the store mounted. The host adds a lease when
# it starts a sandbox, and it drops the lease when the sandbox exits. A lease has one
# job: a removal of the farm that the lease names refuses while the lease is active
# (see remove_farm). A lease never blocks an acquisition run, and it never blocks the
# extension of a farm, because an added link changes no path that a sandbox resolved.
LEASES = LIBS / "leases"

# A farm is assembled in a staging directory beside the farms, then swapped into
# place in one atomic step (see publish_farm). Thus a stop, a refusal, or a crash
# leaves either the old complete farm or the new complete farm, and never a farm with
# links and no records. The staging and the superseded farm are dot-directories, so
# they are unreachable: the host binds `farms/<name>` into a sandbox, and a later run
# reads the same name. recover_farm recovers an interrupted swap.
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

# Acquisition runs are parallel, thus each run stages its installs under a name of
# its own. A run that names its staging `store/.staging` alone would delete the tree
# of a run that is still in flight. _provision sets the token at its start. Outside a
# run the token is empty, and staging_dir gives the plain names.
RUN_TOKEN = ""


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
    req = run_temp("requirements.in")
    req.write_text("\n".join(specs) + "\n")
    out = run_temp("requirements.txt")
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


def run_temp(name: str) -> Path:
    """A temporary path of this run, under /tmp.

    The name carries the run token. Thus two runs that share one container never
    read the fragment of each other.
    """
    return Path("/tmp") / (f"{RUN_TOKEN}-{name}" if RUN_TOKEN else name)


def staging_dir(track: str) -> Path:
    """The private staging directory of this run for `track`.

    The Python track stages under `store/.staging`, and the R track under
    `store/.staging-r`. Inside a run the name carries the run token as well, thus
    two parallel runs never write into one staging tree. A staging tree that a
    crashed run left behind stays until `--repair` clears it, because another run
    can hold a tree of its own at the same moment.
    """
    name = ".staging" if track == "python" else f".staging-{track}"
    return STORE / (f"{name}-{RUN_TOKEN}" if RUN_TOKEN else name)


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
    staging = staging_dir("python") / canon(name)
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)

    # A one-line requirements fragment carrying the pin and its hashes, because
    # `--require-hashes` reads hashes from a file, not from the command line.
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
    return _publish_store_dir(staging, final)


def _publish_store_dir(staging: Path, final: Path) -> tuple[Path, bool]:
    """Publish a staged tree at its content address, and converge on one copy.

    Acquisition runs are parallel, thus two runs can stage the same distribution and
    reach this rename together. The rename of the second run fails, because the store
    directory now exists and it is not empty. The address is the content, thus the two
    trees are identical, and the second run keeps the published copy.
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
    """The distribution name of the store directory that `path` sits inside.

    A store directory is named `<canonical name>-<version>-<hash16>`, thus the name
    is everything before the last two hyphen-separated fields.

    It anchors on the `store` component of the path, and it never scans each part.
    A farm builds under a temporary root whose own name can carry two hyphens, thus
    a scan would read that root as a store directory and report a false collision.
    """
    parts = Path(path).parts
    for i, part in enumerate(parts):
        if part == STORE.name and i + 1 < len(parts):
            head = parts[i + 1].rsplit("-", 2)[0]
            return head or None
    return None


def link_tree(dst: Path, src: str, collisions: list[str]) -> None:
    """Symlink every entry of `src` into `dst`, merging directories on collision.

    Two distributions sharing a top-level name — a namespace package like
    `mpl_toolkits` or `google` — cannot both be a symlink at the same point, so
    the shared prefix is promoted to a real directory and both sides are linked
    beneath it. That promotion is the only reason the farm holds real directories.

    A shared name is NOT always a namespace package. A wheel that is packaged
    loosely ships a top-level `tests`, `benchmarks`, or `resources` directory with
    its own `__init__.py`, and the catalog holds each of those three from two
    distributions. A merge is what an install into one `site-packages` produces, so
    a merge is what happens here.

    Two versions of ONE distribution are the exception, and they raise. A farm links
    one directory for a top-level name, thus the second version would shadow the
    first and an import would read a version that no lock names. The composer of the
    CLI refuses at the same point, and the parity fixture holds the two together.

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
            previous_name, target_name = store_dir_name(previous), store_dir_name(target)
            if previous_name is not None and previous_name == target_name:
                raise SystemExit(
                    f"[provision] refusing to farm {entry}: two versions of {previous_name} "
                    f"reach one farm ({previous} vs {target}). A farm resolves one version "
                    f"for a name, thus one version would shadow the other.")
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

    # Console scripts land in <target>/bin under `uv pip install --target`. Hoist
    # them, so the sandbox can put one directory on PATH.
    #
    # Each hoisted link is RELATIVE to the farm's own site-packages. build_farm writes
    # the farm at a staging path, and publish_farm renames it to the live name. Thus a
    # link that names the farm by an absolute path keeps the staging path, and it
    # dangles after the rename. A relative link moves with the tree.
    #
    # link_tree cannot express this hoist. It writes the same path that it reads, and
    # it decides a collision from that path, but a relative path does not resolve from
    # the working directory. The hoist needs no merge: it reads one directory, and each
    # name in that directory is unique.
    if (site / "bin").is_dir():
        binroot = farm / "python" / "bin"
        binroot.mkdir(parents=True, exist_ok=True)
        for entry in sorted(os.listdir(site / "bin")):
            if entry in NOT_CONTENT:
                continue
            link = binroot / entry
            # A run that builds no Python track carries the old bin forward. Write each
            # link again, thus an absolute link from an earlier run becomes relative.
            if link.is_symlink() or link.exists():
                link.unlink()
            link.symlink_to(f"../site-packages/bin/{entry}")

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


def carry_tree_forward(src: Path, dst: Path) -> None:
    """Write the tree at `src` again under `dst`, one directory and one link at a time.

    A farm track is a view of the store, and it is not content. Its meaning is the
    shape of the tree and the target text of each link, and the sandbox resolves that
    text. Thus this walk writes a directory and a link only, and it copies no
    metadata. The walk goes to any depth, because r/cran, r/bioconductor, and
    r/github each hold one more level.

    shutil.copytree cannot do this work. It calls copystat on each new link, and
    copystat reads the extended attributes of the source link with llistxattr. On a
    macOS directory that podman bind-mounts through virtiofs, that call returns ENOENT
    for a link that is present and valid. Thus copytree named the source path as the
    absent one, and every entry of a real R track failed.

    A regular file is not part of a track today, because build_farm and build_r_farm
    write a directory and a link only. But the warm step can write a bytecode cache
    into the farm. Thus the walk copies the bytes of a regular file, and nothing more.
    """
    try:
        dst.mkdir(parents=True)
    except OSError as exc:
        raise SystemExit(
            f"[provision] cannot make the directory {dst} for the carry-forward: {exc}"
        ) from exc
    for name in sorted(os.listdir(src)):
        src_entry = src / name
        dst_entry = dst / name
        try:
            if src_entry.is_symlink():
                os.symlink(os.readlink(src_entry), dst_entry)
            elif src_entry.is_dir():
                carry_tree_forward(src_entry, dst_entry)
            elif src_entry.is_file():
                # copyfile, not copy2. copy2 adds copystat, and the mode of one
                # entry is not necessary. The run gives the whole farm one mode.
                shutil.copyfile(src_entry, dst_entry)
            else:
                raise SystemExit(
                    f"[provision] cannot carry the farm entry {src_entry} forward: "
                    f"it is not a directory, a link, or a file")
        except OSError as exc:
            # Name the entry and the true cause. The old message named the source
            # path as absent, but the source was present, and the metadata layer of
            # the mount was the cause. A wrong blame hides the true cause.
            raise SystemExit(
                f"[provision] cannot carry the farm entry {src_entry} forward to "
                f"{dst_entry}: {exc}") from exc


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
                # The walk keeps each link as a link. As a result the carry-forward
                # reads no package byte, and it cannot follow a link into the store.
                carry_tree_forward(src, staging / entry)
                carried = True
            elif src.is_file():
                # r-bulk.lock is a record beside the track, and it is a regular file.
                # copy2 reads the source as a file, thus it never calls llistxattr on
                # a link, and it holds no risk on virtiofs. Measured in the container.
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
    return _publish_store_dir(wrap, final)


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
    stage_root = staging_dir("r")
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
    # The record of what this run farmed. The load check runs in a sandbox-base
    # container, thus it belongs to the invoker and not to this run. It reads this
    # record, thus it loads the set that the run produced and it walks no farm.
    # `compiled` marks a package that carries a shared object. The check reads the
    # registered native routines of such a package, thus it runs the compiled code.
    farmed = [{"name": name,
               "subtree": sub,
               "store_dir": store_dir.name,
               "compiled": (store_dir / name / "libs").is_dir()}
              for sub in R_SUBTREES for name, store_dir in stored[sub]]
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
    return {"packages": counts, "farmed": farmed,
            "r_version": r_version_of(manifest), "bioc_releases": releases}


# numba names each cache data file after the function and the absolute directory of
# its source, and NUMBA_DEBUG_CACHE reports each file that it loads or saves. The
# effectiveness check parses the same two lines, thus the two sides must agree on
# this pattern. Refer to scripts/lib-store-cache-check.py.
CACHE_EVENT = re.compile(r"\[cache\] data (loaded from|saved to) ['\"](.+?)['\"]")


def cache_entry_key(path: str, root: Path) -> str:
    """The portable name of one numba cache data file.

    The name of the file holds the module, the qualified name, the first line, and
    the ABI tag. Its directory holds a hash of the absolute directory of the source,
    which is the farm path that the sandbox imports from. Thus the whole key
    describes the prepared entry and nothing of the machine that prepared it.

    The root is the one part that differs between the two runs, because the sandbox
    copies the cache out of the read-only store before it runs. Thus the key drops
    the root. A path outside the root keeps its full name, and no such path can
    match a recorded entry.
    """
    rel = os.path.relpath(path, root)
    return path if rel.startswith("..") else rel


def warm(farm: Path, modules: list[str], script: str | None) -> dict[str, object]:
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

    A module of the workload that does not import, and a script that exits
    non-zero, stop the run. The declaration states which packages an analysis
    reaches first, thus a module that cannot run is a broken catalog.

    The run makes the record of the prepared entries in a second pass over the same
    workload. numba keys an index entry on the type signature of the call. A
    signature that holds a type which a `type()` call builds never matches its index
    again, thus such an entry writes on each run and it loads on none. The second
    pass reports which entry a later run reuses, and only those entries enter the
    record.

    A measurement does this work, and a list of names cannot. The next package
    update writes another kernel of that shape, and a list does not change with it.
    """
    # Warm through /mnt/libs/current, NOT through the farm's own path. numba's
    # cache index key includes the source file's path, so warming via
    # /mnt/libs/farms/<name>/... produces keys the sandbox — which imports via
    # /mnt/libs/current/... — will never match. Measured: warming through the farm
    # path yields 0 loads and 29 recompiles; through `current`, 29 loads and 0.
    #
    # The store carries no pointer, thus the invoker of this container supplies the
    # path: it binds the target farm at /mnt/libs/current for the run. The check
    # comes before the first cache write, thus a run that fails here leaves no
    # cache behind.
    #
    # A bind mount is not a symlink, thus no comparison of two paths can tell that
    # the bind resolves this farm. Write a probe into the farm, and read it through
    # the bind. The name of the probe is new, thus no cache of the engine holds a
    # miss for it, and the lookup reaches the directory of the farm.
    bind = LIBS / "current"
    probe = farm / f".inflexa-bind-probe-{uuid.uuid4().hex}"
    try:
        probe.write_text("probe\n")
        resolved = (bind / probe.name).is_file()
    finally:
        probe.unlink(missing_ok=True)
    if not resolved:
        raise SystemExit(
            f"[provision] the preparation run cannot resolve the farm at {bind}. "
            f"The invoker must bind {farm} there, read-write, nested inside the "
            f"store-root bind. A numba cache key holds the source path that the "
            f"sandbox imports from, thus a cache that this run writes through any "
            f"other path never loads.")
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

    jobs = [(m, ["-c", f"import {m}"], f"the declared module {m} does not import")
            for m in modules]
    if script:
        jobs.append((f"script:{Path(script).name}", [script],
                     f"the workload script {script} exited non-zero"))

    def child(argv: list[str], environment: dict[str, str], failure: str):
        proc = subprocess.run([PYTHON, *argv], env=environment,
                              capture_output=True, text=True)
        if proc.returncode != 0:
            # The tail, not one line: the last line of a traceback is the exception,
            # and the frames above it name the module that raised.
            tail = (proc.stderr or "").strip().splitlines()[-8:]
            detail = "\n  ".join(tail) if tail else "(the child wrote nothing to stderr)"
            raise SystemExit(
                f"[provision] {failure} (exit {proc.returncode}). The preparation "
                f"run stops here, and it prepares no module after it:\n  {detail}")
        return proc

    results: dict[str, object] = {}
    for label, argv, failure in jobs:
        started = time.monotonic()
        child(argv, env, failure)
        results[label] = f"ok in {time.monotonic() - started:.1f}s"
        log(f"  warm {label}: {results[label]}")

    # The pass that records. It runs the same workload with the cache debug on, thus
    # an entry that loads here is an entry that a later run of this workload reuses.
    # An entry that writes again names a kernel that no run reuses, and the record
    # leaves it out. The check judges the record, thus that kernel fails nothing.
    cache_root = Path(env["NUMBA_CACHE_DIR"])
    debug = {**env, "NUMBA_DEBUG_CACHE": "1"}
    prepared: set[str] = set()
    rewritten: set[str] = set()
    for label, argv, failure in jobs:
        proc = child(argv, debug, failure)
        for event, path in CACHE_EVENT.findall(proc.stdout + proc.stderr):
            key = cache_entry_key(path, cache_root)
            (prepared if event == "loaded from" else rewritten).add(key)

    index_files = len(list(cache_root.rglob("*.nbi")))
    log(f"  numba cache: {index_files} index file(s), "
        f"{len(prepared)} prepared entry(s) recorded")
    for key in sorted(rewritten - prepared):
        # A person judges the workload, and this is what shows a kernel that the
        # preparation cannot carry forward. Refer to D8 of the change design.
        log(f"    no run reuses {key}")
    results["cache_entries"] = sorted(prepared)
    results["_numba_index_files"] = str(index_files)
    return results


def script_sha256(script: str | None) -> str | None:
    """The content hash of the workload script, or None when the run names none.

    A path can point at another file later. Thus the record holds the hash of the
    bytes that ran, and the effectiveness check confirms those bytes before it
    replays them.
    """
    if not script:
        return None
    with contextlib.suppress(OSError):
        return hashlib.sha256(Path(script).read_bytes()).hexdigest()
    return None


def prepare_caches(farm: Path, args) -> int:
    """Warm the caches of a farm that an earlier run published, and build nothing.

    A publish replaces the farm directory with another one (refer to publish_farm).
    The invoker binds the farm at /mnt/libs/current before the container starts,
    thus a run that publishes leaves that bind on the directory that it superseded.
    As a result the preparation of the caches is a run of its own.

    The lock of the farm carries the record. It holds the workload, which is the
    module list and the hash of the script, and it holds the entries that the
    workload prepared. The effectiveness check reads exactly that record.
    """
    lock_path = farm / "lock.json"
    if not lock_path.is_file():
        raise SystemExit(
            f"[provision] no farm to prepare at {farm}. A preparation run warms the "
            f"farm that an earlier run published, thus build the farm first.")

    lock = json.loads(lock_path.read_text())
    modules = [m for m in args.warm.split(",") if m]
    results = warm(farm, modules, args.warm_script)
    lock["warm_script"] = args.warm_script
    lock["warm_workload"] = {
        "modules": modules,
        "script_sha256": script_sha256(args.warm_script),
        # The entries that a later run of this workload reuses. The check loads each
        # one, and a write outside this set names a kernel that no run reuses.
        "cache_entries": results.pop("cache_entries"),
    }
    lock["warm"] = results
    lock_path.write_text(json.dumps(lock, indent=2) + "\n")
    # The caches that the warm wrote get the mode the sandbox reads them with.
    subprocess.run(["chmod", "-R", "a+rX", str(farm)], check=True)
    log(f"farm '{farm.name}' prepared: "
        f"{len(lock['warm_workload']['cache_entries'])} cache entry(s) recorded")
    return 0


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


def recover_farm(farm_name: str) -> list[str]:
    """Recover an interrupted swap of one farm, and clear the debris of that farm.

    publish_farm assembles the new farm in farms/.staging-<name> and, on a platform
    without RENAME_EXCHANGE, moves the old farm to farms/.superseded-<name> for one
    instant. A superseded farm means the swap started. When the farm is now missing,
    the swap died between the two renames, thus the old farm goes back. Otherwise the
    new farm is already in place, and the superseded copy is only debris.

    This step reads and writes the entries of one farm only. Thus a run repairs its
    own farm while another run builds a different farm.
    """
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
    # Any staging farm left now is an un-published build, or the old farm that a
    # completed RENAME_EXCHANGE left behind. Neither is the reachable farm.
    if stg.exists():
        shutil.rmtree(stg, ignore_errors=True)
        cleared.append(f"farms/{stg.name}")
    return cleared


def repair_staging() -> int:
    """Clear every abandoned staging tree, and recover each interrupted farm swap.

    A store staging directory only ever holds an install in flight: a completed
    publish is a rename OUT of it, so anything left there is debris from a run that
    died before its rename, never a published artifact. Removing it reclaims space and
    can never lose a package. The Python track stages in store/.staging-<token>, and
    the R track in store/.staging-r-<token>, one token for each run.

    A farm swap can also stop in the middle, and recover_farm restores it. Thus the
    reachable farm is always the old complete farm or the new complete farm, never a
    half-built tree.

    This step reads the whole store, thus it runs under the exclusive lock. A run in
    flight holds a staging tree of its own, and this step would delete it.
    """
    cleared = []
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
    else:
        log("repair: nothing to clear")
    return 0


# --- The two locks ------------------------------------------------------------
# One lock file carries two modes. An acquisition run takes the shared mode, because
# content addressing makes the pool writes race-safe and two runs that produce the
# same distribution converge on one store directory. Reclaim, repair, and a farm
# removal take the exclusive mode, because each of them reads the whole store and
# deletes from it.
#
# A second lock file is the commit mutex. The shared metadata — the dependency graph
# and the inventory — is read-modify-write, thus one short mutex serializes each
# commit. A run takes the store lock first and the commit mutex second. No code takes
# them in the other order, thus no deadlock is possible.


@contextlib.contextmanager
def _flock(path: Path, mode: int, wait: bool, busy: str):
    """Hold one flock, and report `busy` when another holder has it.

    A step that waits reports the condition, and then it blocks. A step that does
    not wait stops with the same condition, thus a caller never queues behind work of
    an unknown length. The close of the fd releases the flock, and a crash closes it
    too.
    """
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
        yield
    finally:
        os.close(fd)


@contextlib.contextmanager
def store_lock_shared():
    """Hold the store lock in the shared mode, for one acquisition run.

    Two acquisition runs hold it at the same time. Only reclaim excludes them, and
    the run then reports that conflict. It does not wait behind a scan of unknown
    length.
    """
    with _flock(LIBS / ".provision.lock", fcntl.LOCK_SH, False,
                "reclaim holds the store lock"):
        yield


@contextlib.contextmanager
def store_lock_exclusive(wait: bool = True):
    """Hold the store lock in the exclusive mode, for reclaim, repair, or a removal.

    The step waits for zero acquisition runs, and it blocks a new one while it holds
    the lock. A run that wrote pool directories and did not commit yet holds exactly
    what reclaim deletes, thus the two must never overlap.
    """
    with _flock(LIBS / ".provision.lock", fcntl.LOCK_EX, wait,
                "an acquisition run holds the store lock"):
        yield


@contextlib.contextmanager
def commit_lock():
    """Hold the short mutex that serializes each write to the shared metadata.

    The mutex blocks, because a commit is short and two commits must serialize. A
    reader of the graph or the inventory thus never sees a half-written record.
    """
    with _flock(LIBS / ".commit.lock", fcntl.LOCK_EX, True,
                "another run commits its metadata"):
        yield


def active_leases() -> list[str]:
    """Ids of sandboxes the host has recorded as holding the store mounted."""
    if not LEASES.is_dir():
        return []
    return sorted(p.name for p in LEASES.iterdir() if p.is_file())


def lease_farm(lease_id: str) -> str | None:
    """The farm that one lease names, or None when the lease names none."""
    try:
        record = json.loads((LEASES / lease_id).read_text())
    except (OSError, ValueError):
        return None
    return record.get("farm") if isinstance(record, dict) else None


def leases_of_farm(farm_name: str) -> list[str]:
    """Ids of the leases that hold `farm_name`, or that name no farm at all.

    A lease that names no farm can be a sandbox of any farm, thus it holds every
    farm. The host names the farm of each sandbox it starts, and only an old lease
    or an incomplete invoker leaves the name out.
    """
    return [lease for lease in active_leases()
            if lease_farm(lease) in (farm_name, None)]


def add_lease(lease_id: str, farm_name: str | None = None) -> int:
    """Record that a sandbox holds the store mounted, and which farm it reads.

    The farm is what makes the removal guard exact: a removal refuses for the farm
    that a lease names, and it goes ahead for each other farm.
    """
    LEASES.mkdir(parents=True, exist_ok=True)
    (LEASES / lease_id).write_text(
        json.dumps({"lease": lease_id, "farm": farm_name}) + "\n")
    log(f"lease added: {lease_id} (farm: {farm_name or 'not named'})")
    return 0


def drop_lease(lease_id: str) -> int:
    p = LEASES / lease_id
    if p.exists():
        p.unlink()
        log(f"lease dropped: {lease_id}")
    else:
        log(f"lease not found: {lease_id}")
    return 0


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
    referenced stay until reclaim runs. The removal refuses while a lease records a
    live sandbox of that farm, because that sandbox resolves these links now."""
    farm = FARMS / farm_name
    if not farm.is_dir():
        log(f"remove-farm: no such farm {farm_name}")
        return 2
    holders = leases_of_farm(farm_name)
    if holders:
        raise SystemExit(
            f"[provision] refusing to remove farm {farm_name}: "
            f"{len(holders)} sandbox lease(s) hold it ({', '.join(holders[:5])}). "
            f"A live sandbox resolves this farm at /mnt/libs/current.")
    shutil.rmtree(farm, ignore_errors=True)
    log(f"removed farm {farm_name} (run --reclaim to drop store dirs it alone referenced)")
    return 0


def _acquire(args) -> int:
    """Acquire the specs into the pool, and build no farm.

    This is what `inflexa store add` runs. The store carries no active farm, thus an
    acquisition has no farm to write: it resolves the closure of the specs, it
    installs each distribution into the content-addressed pool, and it appends the
    resolved edges to the dependency graph. The farm of an analysis changes only
    through composition, which the host does with no container.

    The graph append is the whole commit of the run, thus it is the only step under
    the commit mutex. The pool writes before it are private to this run: a store
    directory publishes at its content address, and two runs that produce one
    distribution converge on one directory.

    The specs of the run are the batch that the graph learns. `resolve` settles every
    requirement of every distribution, thus the batch is closed and each edge of it
    names a node of it.
    """
    global RUN_TOKEN
    RUN_TOKEN = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"

    STORE.mkdir(parents=True, exist_ok=True)
    requested = sorted(set(args.specs))
    resolved = resolve(requested)
    store_dirs: list[Path] = []
    added: list[str] = []
    for pin in resolved:
        path, is_new = ensure_stored(pin, resolved[pin])
        store_dirs.append(path)
        if is_new:
            added.append(pin)
    log(f"{len(added)} newly installed, {len(resolved) - len(added)} reused from store")
    shutil.rmtree(staging_dir("python"), ignore_errors=True)

    with commit_lock():
        emit_deps.append_store_dirs(LIBS, store_dirs)

    log(f"acquired {len(resolved)} distribution(s) into the pool; no farm was built")
    return 0


def _provision(args) -> int:
    global RUN_TOKEN
    # The token separates the staging trees of this run from the staging trees of
    # each parallel run. It carries the pid for a reader of a log, and a random part
    # because two containers can hold the same pid.
    RUN_TOKEN = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"

    STORE.mkdir(parents=True, exist_ok=True)
    FARMS.mkdir(parents=True, exist_ok=True)
    # Recover the farm of this run before it builds: an interrupted swap can have
    # left the old farm at the superseded name. Another farm belongs to another run,
    # and only the exclusive `--repair` reads the whole store.
    recover_farm(args.farm)

    farm = FARMS / args.farm
    if args.warm or args.warm_script:
        if args.specs or args.r_manifest:
            raise SystemExit(
                f"[provision] a run that builds a farm cannot also warm it. The "
                f"publish replaces the directory that the bind at {LIBS / 'current'} "
                f"holds, thus the warm would write a cache into the farm that the "
                f"publish superseded. Build the farm in one run. Then prepare the "
                f"caches in a run of its own, with no spec and with the farm bound.")
        return prepare_caches(farm, args)

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
        shutil.rmtree(staging_dir("python"), ignore_errors=True)

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
        # The empty record of a farm that nothing prepared. A preparation run fills
        # the three keys, and it is a run of its own (refer to prepare_caches).
        #
        # A build resets them. It carries the cache of the old farm forward, and that
        # cache describes the package set of the old farm. Thus the record that
        # published with the old farm cannot describe this one.
        "warm_script": None,
        "warm_workload": {"modules": [], "script_sha256": None, "cache_entries": []},
        "warm": {},
    }

    def write_lock(dest: Path) -> None:
        (dest / "lock.json").write_text(json.dumps(lock, indent=2) + "\n")

    # The commit of the run. The inventory and the dependency graph are shared
    # metadata, and each of the two is read-modify-write, thus one short mutex
    # serializes this section across the parallel runs. Every step before it wrote
    # into the pool or into the staging farm, which are private to this run.
    with commit_lock():
        # The records go into the staging farm, thus the farm the swap publishes
        # already holds every marker the harness needs. The same producer the images
        # use writes packages.txt, so it is byte-identical in shape to what
        # list_available_packages already parses.
        subprocess.run(["/usr/local/bin/inflexa-libs-refresh", "--rederive"],
                       env={**os.environ, "INFLEXA_LIB_ROOT": str(staging)}, check=True)

        # Second of the two completeness markers libStoreUsable requires before it
        # will bind the store; without it the mount is silently dropped. The track
        # list comes from the staging farm as it publishes, thus it names each
        # preserved track beside each rebuilt one.
        tracks = farm_tracks(staging)
        (staging / "meta.json").write_text(json.dumps({
            "version": args.farm,
            "arch": f"linux-{'arm64' if os.uname().machine == 'aarch64' else 'amd64'}",
            "tracks": tracks,
        }, indent=2) + "\n")

        write_lock(staging)
        # The mode goes with the records, because the sandbox reads the farm as a
        # different uid the moment its bind selects the farm.
        subprocess.run(["chmod", "-R", "a+rX", str(staging)], check=True)

        # The staging farm is complete. Swap it into place in one atomic step, thus
        # the farm is never a half-built tree that the harness could mount or a later
        # run could read. From here on `farm` is the new complete farm.
        publish_farm(staging, farm)

        # Append the closure of the published farm to the graph at the store root.
        # The append reads the links of the farm, thus it runs after the swap. A node
        # that the graph already holds stays as it is.
        emit_deps.append_for_farm(LIBS, farm)

    log(f"farm '{args.farm}' ready: {len(pins)} distributions")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Provision packages into the library store.",
        epilog=(
            "The invoker binds the store root read-write at /mnt/libs.\n"
            "\n"
            "With no --farm the run acquires its specs into the pool and builds no\n"
            "farm. The host composes the farm of each analysis from that pool.\n"
            "\n"
            "A run that warms the caches (--warm, --warm-script) needs a second bind:\n"
            "the target farm at /mnt/libs/current, nested inside the store-root bind.\n"
            "The store carries no active-farm pointer, thus only that bind puts the\n"
            "farm at the path the sandbox imports from, and a numba cache key holds\n"
            "that path. A run that cannot resolve the farm there fails, and it names\n"
            "the bind that it wants.\n"
            "\n"
            "Such a run passes no spec, because it prepares the caches of a farm that\n"
            "an earlier run published. A publish replaces the farm directory, and the\n"
            "bind of the container then holds the directory that the publish\n"
            "superseded. Thus one run builds the farm, and the next one prepares it."))
    ap.add_argument("--farm", help="analysis name (farm directory); with --add-lease, "
                                   "the farm that the sandbox of the lease reads; omit it "
                                   "to acquire the specs into the pool and build no farm")
    ap.add_argument("--verify", action="store_true",
                    help="re-hash every store directory, report any drift from its address, and exit")
    ap.add_argument("--repair", action="store_true",
                    help="clear each abandoned staging tree from an interrupted run, and exit "
                         "(exclusive: it waits for every acquisition run to finish)")
    ap.add_argument("--reclaim", action="store_true",
                    help="remove store directories no farm references, and exit "
                         "(exclusive: it waits for every acquisition run to finish)")
    ap.add_argument("--add-lease", default=None, metavar="ID",
                    help="record that a sandbox holds the store mounted; pass --farm to name "
                         "the farm that it reads (a lease blocks the removal of that farm)")
    ap.add_argument("--drop-lease", default=None, metavar="ID",
                    help="clear a sandbox's mount lease")
    ap.add_argument("--remove-farm", default=None, metavar="NAME",
                    help="remove a farm's symlinks (store dirs stay until --reclaim), and exit")
    ap.add_argument("--warm", default="",
                    help="comma-separated modules to import during warm-up; the run prepares "
                         "an existing farm, thus it passes no spec, and the invoker must bind "
                         "that farm at /mnt/libs/current")
    ap.add_argument("--warm-script", default=None,
                    help="path (inside the store) to a script that exercises jitted code paths; "
                         "the run prepares an existing farm, thus it passes no spec, and the "
                         "invoker must bind that farm at /mnt/libs/current")
    ap.add_argument("--r-manifest", default=None,
                    help="path to a lib-store manifest; provision its R track (CRAN + Bioconductor + git + GitHub) via pak")
    ap.add_argument("specs", nargs="*", help="requirement specs to add")
    args = ap.parse_args()

    if args.verify:
        return verify_store()
    if args.repair:
        with store_lock_exclusive():
            return repair_staging()
    if args.reclaim:
        with store_lock_exclusive():
            return reclaim()
    if args.add_lease:
        return add_lease(args.add_lease, args.farm)
    if args.drop_lease:
        return drop_lease(args.drop_lease)
    if args.remove_farm:
        with store_lock_exclusive():
            return remove_farm(args.remove_farm)
    reject_off_index(args.specs)

    # A run with no --farm is an ACQUISITION run: it writes the pool and the graph,
    # and it builds no farm. That is what the CLI `store add` runs, because each
    # analysis composes its own farm on the host. The R track still needs a farm,
    # because provision_r links each installed package into one.
    if not args.farm:
        if not args.specs:
            log("usage: <specs> to acquire into the pool, --farm <name> (with specs / "
                "--r-manifest) to build a farm, or --verify / --repair / --reclaim / "
                "--add-lease ID / --drop-lease ID / --remove-farm NAME")
            return 2
        if args.r_manifest:
            log("usage: --r-manifest needs --farm <name>; an R install farms each package it stores")
            return 2
        with store_lock_shared():
            return _acquire(args)

    # An acquisition run takes the shared mode, thus two runs proceed at the same
    # time and only reclaim excludes them.
    with store_lock_shared():
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
