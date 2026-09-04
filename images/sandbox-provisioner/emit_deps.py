#!/usr/bin/env python3
"""Publish the dependency graph of the package store as deps.json.

The graph is one file at the store root. A node is one store directory, and the
name of that directory is the key of the node. A node carries its track, its
identity name, its version, its import names, its entry points, and its edges. An
edge names another node exactly. The graph holds no version range, because pip and
pak resolve each constraint at build time.

The graph also carries an order. `by_name` holds, for each track and each
identity name, the store directories of that name with the newest first. A
consumer that names no version takes the head, and a consumer that names one reads
the version of each node. A release comes before a pre-release, thus a pre-release
heads a name only when the pool holds no release of that name.

The unit of work is a resolved set, which is the closure of one farm. The emitter
resolves each edge inside that set. Thus two farms that hold two versions of one
package give two nodes, and each edge lands on the version of its own farm.

Python nodes come from importlib.metadata. Each environment marker evaluates in
this image, thus a marker gives its runtime truth. No extra is active, thus a
requirement under `extra == "test"` drops. R nodes come from the DESCRIPTION
fields Depends and Imports, which one Rscript call reads with read.dcf.

LinkingTo gives no edge. LinkingTo is a build-time field, and it names the
headers of a source build. R never loads such a package at run time, and pak
omits it from a binary install. Thus a LinkingTo name enters no pool, and an
edge to it would always dangle.

An edge into a package that the image owns drops against the fixed list in
base-packages.json. Each other edge must land on a node. The emitter fails and
names the edge when it does not, thus a build stops on an incomplete closure.

An append never rewrites a node that the graph already holds. A store directory
is content-addressed and write-once, thus its metadata cannot change, and an
earlier node stays byte-identical.

Run the emitter inside the provisioner image:

    emit_deps.py --store-root /mnt/libs                 # every farm
    emit_deps.py --store-root /mnt/libs --farm catalog  # one farm
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import subprocess
import sys
from importlib.metadata import Distribution
from packaging.markers import InvalidMarker, Marker
from packaging.version import InvalidVersion, Version
from pathlib import Path

from package_identity import address, identity_of, python_identity, r_identity

# The graph, at the store root. The name is part of the store contract, because a
# consumer reads the closure from it.
GRAPH_NAME = "deps.json"

# The schema version of the graph. A reader that does not know this version refuses
# the graph, because a field of another shape gives a wrong answer in silence.
# A new field keeps this version, because a reader that does not know the field
# ignores it. Only a change to a field that a reader already reads makes a new
# version necessary.
#
# Version 2 keys the R track by the DESCRIPTION spelling. A version-1 graph keys
# it in lower case, thus a version-2 reader that reads a version-1 graph misses
# every R package and gives no other sign. The version turns that silence into
# one named refusal.
GRAPH_VERSION = 2

# The packages that the image owns, recorded beside the emitter.
BASE_PACKAGES_FILE = Path(__file__).with_name("base-packages.json")

# The rule that a revealed name obeys. A build stops on such a name, and the reader
# then makes one decision. The gate below carries this text, and so does the test
# that holds the list to the image, thus the rule has one wording.
REVEALED_NAME_RULE = (
    "A revealed name goes to one of two files:\n"
    "  the sandbox imports the package -> images/package-store/manifest.yaml\n"
    f"  the sandbox image carries the package -> {BASE_PACKAGES_FILE.name}"
)

# A store directory of a Python distribution carries this suffix at its root. A
# store directory of an R package carries DESCRIPTION one level down instead.
DIST_INFO_SUFFIX = ".dist-info"

# The entry-point groups that the farm hoists to a directory on PATH. Another
# group names a plugin, not a command, thus the node does not record it.
SCRIPT_GROUPS = ("console_scripts", "gui_scripts")

# Entries of a store directory that are never an import name.
NOT_AN_IMPORT_SUFFIX = (DIST_INFO_SUFFIX, ".egg-info", ".data", ".libs", ".dylibs")
NOT_AN_IMPORT_NAME = {"bin", "__pycache__"}

# One Rscript call reads each DESCRIPTION. read.dcf is the parser of record for the
# format, thus a field that continues on an indented line reads correctly. The
# script reads one package directory for each line of stdin, and it writes one
# line for each package: the directory, a tab, and the raw field values.
R_READ_DCF = (
    'fields <- c("Depends", "Imports"); '
    'for (p in readLines(file("stdin"))) { '
    'd <- tryCatch(read.dcf(file.path(p, "DESCRIPTION"), fields = fields), '
    'error = function(e) NULL); '
    'v <- if (is.null(d)) "" else paste(d[!is.na(d)], collapse = ","); '
    'cat(p, "\\t", gsub("[\\r\\n]+", " ", v), "\\n", sep = "") '
    '}'
)

# The name at the start of a requirement, before an extra, a specifier, or a marker.
REQUIREMENT_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")


def log(msg: str) -> None:
    print(f"[deps] {msg}", flush=True)


# --- Environment markers ------------------------------------------------------
# A marker is a boolean expression over a fixed set of variables, and the rules of
# PEP 508 and PEP 440 that compare a version are subtle. `packaging` is the
# reference implementation of both, thus the emitter reads a marker with it and
# never with a parser of its own. The Dockerfile installs `python3-packaging`, so
# the import cannot depend on a transitive arrival.

def marker_environment() -> dict[str, str]:
    """The PEP 508 environment of this image, with no extra active.

    `extra` is the empty string. Thus a marker such as `extra == "test"` is false,
    and the graph records the mandatory closure only.
    """
    info = sys.implementation.version
    level = "" if info.releaselevel == "final" else info.releaselevel[0] + str(info.serial)
    return {
        "os_name": os.name,
        "sys_platform": sys.platform,
        "platform_machine": platform.machine(),
        "platform_release": platform.release(),
        "platform_system": platform.system(),
        "platform_version": platform.version(),
        "python_version": ".".join(platform.python_version_tuple()[:2]),
        "python_full_version": platform.python_version(),
        "implementation_name": sys.implementation.name,
        "implementation_version": f"{info.major}.{info.minor}.{info.micro}{level}",
        "platform_python_implementation": platform.python_implementation(),
        "extra": "",
    }


def edge_name(requirement: str, env: dict[str, str]) -> str | None:
    """The distribution name of `requirement`, or None when its marker is false.

    A marker that does not read keeps the edge, and the emitter reports it. A kept
    edge that names no node stops the build with the name of the edge, but a
    dropped edge would leave the closure short with no report.

    Two failures are possible, and both keep the edge. `InvalidMarker` is a marker
    that does not parse. `InvalidVersion` is a comparison against a value that is
    no version of PEP 440: `platform_release` carries a kernel release such as
    `7.0.9-205.fc44.aarch64`, thus a marker that compares it raises rather than
    gives an answer.
    """
    body, _, marker = requirement.partition(";")
    match = REQUIREMENT_NAME.match(body)
    if match is None:
        return None
    name = match.group(1)
    if marker.strip():
        try:
            if not Marker(marker).evaluate(env):
                return None
        except (InvalidMarker, InvalidVersion) as exc:
            log(f"WARNING: cannot read the marker {marker.strip()!r} ({exc}); "
                f"the emitter keeps the edge to {name}")
    return name


# --- The version order --------------------------------------------------------
# The pool can hold more than one version of one name, and a consumer that names no
# version wants the newest. A sort of the text gives the wrong answer, because
# `1.10.3` sorts before `1.9.0` and is the later version. The emitter runs where the
# version rules of both ecosystems are, thus it sorts one time and the graph carries
# the answer. A second sort on a host puts one rule in two places.

def dir_version(key: str, name: str) -> str:
    """The version that a store-directory name records.

    A store directory is named `<address>-<version>-<hash16>`. The address and
    the hash carry no ambiguity, but the version can hold a hyphen, because an R
    version accepts one as a separator. Thus this function removes the known
    address and the last field only, and it never splits on each hyphen.
    """
    rest = key[len(name) + 1:] if key.startswith(f"{name}-") else key
    version, _, _digest = rest.rpartition("-")
    return version or rest


# The count and the width of the padded release segments in an order string. A
# real version of either ecosystem carries far fewer segments, and a segment
# past the width has no realistic value.
_ORDER_SEGMENTS = 8
_ORDER_WIDTH = 8

# The phase character of a Python version, in order: a dev release, then a
# pre-release, then the release, then a post-release. The characters compare
# lexicographically in that order.
_PRE_LETTER = {"a": "1", "b": "2", "rc": "3"}


def order_string(track: str, version: str) -> str:
    """One fixed-width string per version, such that a descending plain string
    sort equals the version order.

    The string is the ONE place where the version rules live. The emitter
    sorts `by_name` with it, and the host commit of an acquisition appends a
    staged node and re-sorts a name with the same plain comparison — thus no
    second copy of the version rules exists on a host.

    The first character is the rank: a release ranks above a pre-release, thus
    a pre-release heads a name only when the pool holds no release of that
    name. A version that does not read ranks below both. The rest is the
    epoch, the zero-padded release segments, and a phase suffix.
    """
    def segments(parts: tuple[int, ...]) -> str:
        padded = (parts + (0,) * _ORDER_SEGMENTS)[:_ORDER_SEGMENTS]
        return "".join(f"{part:0{_ORDER_WIDTH}d}" for part in padded)

    if track == "python":
        try:
            parsed = Version(version)
        except InvalidVersion:
            return "0" + segments(()) + "~" + version
        rank = "1" if parsed.is_prerelease else "2"
        if parsed.dev is not None and parsed.pre is None:
            phase = "1" + f"{parsed.dev:0{_ORDER_WIDTH}d}"
        elif parsed.pre is not None:
            phase = "2" + _PRE_LETTER.get(parsed.pre[0], "0") + f"{parsed.pre[1]:0{_ORDER_WIDTH}d}"
        elif parsed.post is not None:
            phase = "7" + f"{parsed.post:0{_ORDER_WIDTH}d}"
        else:
            phase = "5" + "0" * _ORDER_WIDTH
        return rank + f"{parsed.epoch:04d}" + segments(parsed.release) + phase + "~" + version
    parts = re.split(r"[.-]", version)
    if version and all(part.isdigit() for part in parts):
        return "2" + "0000" + segments(tuple(int(part) for part in parts)) + "5" + "0" * _ORDER_WIDTH + "~" + version
    return "0" + segments(()) + "~" + version


def order_by_name(nodes: dict[str, dict]) -> dict[str, dict[str, list[str]]]:
    """The store directories of each name, newest first, inside a track.

    The key is the IDENTITY name of the track: the PEP 503 fold for a Python
    distribution, and the DESCRIPTION spelling for an R package. One rule for
    both tracks folds `decoupleR` onto `decoupler`, and a lookup then finds one
    key in two tracks.

    The track separates the two maps. One name can still reach a distribution of
    each ecosystem, and the two versions of such a pair order under two rules.
    The sort reads the `order` string of each node, thus the emitter and a host
    commit order a name identically.
    """
    ordering: dict[str, dict[str, list[str]]] = {"python": {}, "r": {}}
    for key, node in nodes.items():
        ordering[node["track"]].setdefault(node["name"], []).append(key)
    for by_name in ordering.values():
        for keys in by_name.values():
            keys.sort(reverse=True,
                      key=lambda store_dir: (nodes[store_dir].get("order", ""), store_dir))
    return ordering


# --- The nodes ----------------------------------------------------------------


def load_base_packages() -> dict[str, set[str]]:
    """The image-owned package names, by track, from the file beside the emitter."""
    try:
        record = json.loads(BASE_PACKAGES_FILE.read_text())
    except (OSError, ValueError) as exc:
        raise SystemExit(f"[deps] cannot read the base package list {BASE_PACKAGES_FILE}: {exc}")
    return {
        "python": {python_identity(name).name for name in record.get("python", [])},
        "r": set(record.get("r", [])),
    }


def dist_info_of(store_dir: Path) -> Path | None:
    """The .dist-info directory of a Python store directory, if there is one."""
    infos = sorted(p for p in store_dir.iterdir()
                   if p.is_dir() and p.name.endswith(DIST_INFO_SUFFIX))
    return infos[0] if infos else None


def r_package_of(store_dir: Path) -> Path | None:
    """The inner directory of an R store directory, if there is one.

    An R store directory nests the package one level down, under its real package
    name, and that inner directory carries DESCRIPTION.
    """
    inners = sorted(p for p in store_dir.iterdir()
                    if p.is_dir() and (p / "DESCRIPTION").is_file())
    return inners[0] if inners else None


def _name_and_version(dist_info: Path) -> tuple[str, str]:
    """The name and the version that a .dist-info directory name records."""
    stem = dist_info.name[: -len(DIST_INFO_SUFFIX)]
    name, _, version = stem.rpartition("-")
    return (name or stem), version


def _metadata_name(dist: Distribution) -> str | None:
    """The Name field of a Python distribution, or None when it has none.

    A store directory that carries no METADATA file is not a fault. The name then
    comes from the name of the .dist-info directory.
    """
    try:
        metadata = dist.metadata
        return metadata["Name"] if metadata else None
    except (OSError, TypeError, ValueError):
        return None


def _requirements(dist: Distribution) -> list[str]:
    """The Requires-Dist lines of a Python distribution."""
    try:
        return list(dist.requires or [])
    except (OSError, TypeError, ValueError):
        return []


# A recorded or derived top-level entry is an import name only when it is
# one Python identifier. A wheel can record junk beside its modules — a
# `-stubs` directory, a stray `site-packages`, a path with a slash — and an
# unimportable entry in the graph fails the load check of a usable package.
_IMPORT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _ships(store_dir: Path, name: str) -> bool:
    """Whether the store directory holds a top-level module of this name."""
    if (store_dir / name).is_dir() or (store_dir / f"{name}.py").is_file():
        return True
    if (store_dir / f"{name}.so").is_file():
        return True
    return any(store_dir.glob(f"{name}.*.so"))


def import_names(store_dir: Path, dist: Distribution) -> list[str]:
    """The top-level modules that a Python distribution gives.

    top_level.txt records them when the wheel carries it. Otherwise the top-level
    entries of the store directory give the same answer, because the store
    directory is the install target of one distribution.
    """
    recorded = None
    try:
        recorded = dist.read_text("top_level.txt")
    except OSError:
        recorded = None
    if recorded:
        names = {line.strip() for line in recorded.splitlines() if line.strip()}
        # The record can claim a valid name that the wheel never shipped
        # (biom-format records `build`, `ci`, `images`, `wheelhouse`). The
        # graph advertises import names, and the load check imports each
        # one, thus only a name that is on disk belongs in the graph. A
        # record whose whole claim misses the disk falls to the walk.
        shipped = sorted(name for name in names
                         if _IMPORT_NAME.match(name) and _ships(store_dir, name))
        if shipped:
            return shipped
    names = set()
    for entry in store_dir.iterdir():
        if entry.name.startswith(".") or entry.name in NOT_AN_IMPORT_NAME:
            continue
        if entry.name.endswith(NOT_AN_IMPORT_SUFFIX):
            continue
        if entry.is_dir():
            names.add(entry.name)
        elif entry.suffix == ".py":
            names.add(entry.stem)
        elif entry.suffix == ".so":
            names.add(entry.name.split(".", 1)[0])
    return sorted(name for name in names if _IMPORT_NAME.match(name))


def entry_point_names(dist: Distribution) -> list[str]:
    """The command names that a Python distribution installs."""
    try:
        points = list(dist.entry_points)
    except (OSError, ValueError):
        return []
    return sorted({point.name for point in points if point.group in SCRIPT_GROUPS})


def r_fields(inner_dirs: list[Path]) -> dict[str, list[str]]:
    """The Depends and Imports names of each installed R package.

    One Rscript call reads every DESCRIPTION, thus the emitter starts R one time
    for a whole closure. Each entry can carry a version constraint in parentheses,
    and this function removes it to keep the bare name.

    LinkingTo gives no name, because it is a build-time field. It names the
    headers of a source build, and R never loads such a package at run time. pak
    omits it from a binary install, thus the pool holds no store directory for it.
    """
    if not inner_dirs:
        return {}
    proc = subprocess.run(
        ["Rscript", "-e", R_READ_DCF],
        input="\n".join(str(p) for p in inner_dirs),
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(
            f"[deps] Rscript could not read the DESCRIPTION of "
            f"{len(inner_dirs)} R package(s) (exit {proc.returncode}).\n"
            f"{proc.stderr.strip() or '(R wrote nothing to stderr)'}")
    fields: dict[str, list[str]] = {}
    for line in proc.stdout.splitlines():
        path, tab, raw = line.partition("\t")
        if not tab:
            continue
        names = []
        for entry in raw.split(","):
            name = entry.split("(", 1)[0].strip()
            if name:
                names.append(name)
        fields[path] = names
    return fields


def collect(store_dirs: list[Path], env: dict[str, str] | None = None) -> dict[str, dict]:
    """One node for each store directory, with each edge resolved inside the set.

    A store directory that is neither a Python distribution nor an R package gets
    no node. A resolved edge names a store directory. Each edge that names no
    node of the set, and no image-owned package, stays in the graph under its
    bare name. The gate then names it, and the run stops.
    """
    env = env or marker_environment()
    base = load_base_packages()
    nodes: dict[str, dict] = {}
    index: dict[str, dict[str, str]] = {"python": {}, "r": {}}
    wanted: dict[str, tuple[str, list[str]]] = {}

    r_inner: dict[str, Path] = {}
    for store_dir in store_dirs:
        if not store_dir.is_dir():
            continue
        key = store_dir.name
        info = dist_info_of(store_dir)
        if info is not None:
            dist = Distribution.at(info)
            fallback, _version = _name_and_version(info)
            identity = python_identity(_metadata_name(dist) or fallback)
            version = dir_version(key, address(identity))
            nodes[key] = {
                "track": "python",
                "name": identity.name,
                "version": version,
                "order": order_string("python", version),
                "imports": import_names(store_dir, dist),
                "entry_points": entry_point_names(dist),
            }
            index["python"][identity.name] = key
            wanted[key] = ("python",
                           [n for n in (edge_name(req, env) for req in _requirements(dist))
                            if n])
            continue
        inner = r_package_of(store_dir)
        if inner is not None:
            # The DESCRIPTION spelling is the identity of an R package, because
            # `library()` is case-sensitive. The store DIRECTORY keeps the
            # address, thus the version strips against the address and never
            # against the identity name.
            identity = r_identity(inner.name)
            version = dir_version(key, address(identity))
            nodes[key] = {
                "track": "r",
                "name": identity.name,
                "version": version,
                "order": order_string("r", version),
                "imports": [identity.name],
                "entry_points": [],
            }
            index["r"][identity.name] = key
            r_inner[key] = inner

    fields = r_fields(sorted(r_inner.values()))
    for key, inner in r_inner.items():
        wanted[key] = ("r", fields.get(str(inner), []))

    for key, (track, names) in wanted.items():
        edges = set()
        for name in names:
            target_name = identity_of(track, name).name
            target = index[track].get(target_name)
            if target is None:
                if target_name in base[track]:
                    continue
                edges.add(name)
            elif target != key:
                edges.add(target)
        nodes[key]["edges"] = sorted(edges)
    return nodes


# --- The graph ----------------------------------------------------------------


def farm_closure(farm: Path, store_root: Path) -> list[Path]:
    """Each store directory that the links of one farm resolve to."""
    store = store_root / "store"
    names: set[str] = set()
    if not farm.is_dir():
        return []
    for link in farm.rglob("*"):
        if link.is_symlink():
            target = os.readlink(link)
            if "/store/" in target:
                names.add(target.split("/store/", 1)[1].split("/", 1)[0])
    return [store / name for name in sorted(names) if (store / name).is_dir()]


def read_graph(store_root: Path) -> dict:
    """The published graph, or an empty graph when the store carries none.

    A graph of another schema version stops the run. Its nodes carry the fields of
    that version, thus the emitter cannot order them and cannot merge them. A
    silent overwrite is worse, because it drops each store directory that the older
    graph names.
    """
    path = store_root / GRAPH_NAME
    try:
        graph = json.loads(path.read_text())
    except (OSError, ValueError):
        return {"version": GRAPH_VERSION, "nodes": {}}
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), dict):
        return {"version": GRAPH_VERSION, "nodes": {}}
    if graph.get("version") != GRAPH_VERSION:
        raise SystemExit(
            f"[deps] {path} carries the schema version {graph.get('version')!r}, "
            f"and this emitter reads the schema version {GRAPH_VERSION}.")
    return graph


def write_graph(store_root: Path, graph: dict) -> None:
    """Write the graph at the store root, in one step.

    The write goes to a temporary file, and a rename publishes it. Thus a reader
    sees the old graph or the new graph, and never a part of one.
    """
    path = store_root / GRAPH_NAME
    temp = store_root / (GRAPH_NAME + ".tmp")
    temp.write_text(json.dumps(graph, indent=2, sort_keys=True) + "\n")
    os.replace(temp, path)


def dangling_edges(nodes: dict[str, dict]) -> list[tuple[str, str]]:
    """Each edge that names no node of the graph."""
    return [(key, edge)
            for key, node in sorted(nodes.items())
            for edge in node.get("edges", [])
            if edge not in nodes]


def both_track_names(nodes: dict[str, dict]) -> list[str]:
    """Each identity name that the Python track and the R track both hold."""
    python = {node["name"] for node in nodes.values() if node.get("track") == "python"}
    r = {node["name"] for node in nodes.values() if node.get("track") == "r"}
    return sorted(python & r)


def gate(nodes: dict[str, dict]) -> None:
    """Stop the build on a dangling edge, and report each both-track name.

    A node carries ONE name, its identity name, thus no field of a node can
    disagree with another about the identity of its package.

    The gate REPORTS each name that both tracks hold in one spelling. A plan
    must qualify such a name with `python:` or `r:`, thus the planner must see
    the list. The report is a log line, and the run continues.
    """
    shared = both_track_names(nodes)
    if shared:
        log("the Python track and the R track hold these names in one spelling, "
            "thus a plan must name the track of each one as `python:<name>` or "
            f"`r:<name>`: {', '.join(shared)}")

    bad = dangling_edges(nodes)
    if not bad:
        return
    lines = "\n".join(f"  {key} -> {edge}" for key, edge in bad)
    raise SystemExit(
        f"[deps] {len(bad)} edge(s) name a node that the graph does not hold. "
        f"The closure is short, or the marker of the requirement read wrong:\n{lines}\n"
        + REVEALED_NAME_RULE)


def _merge(store_root: Path, batches: list[list[Path]]) -> dict:
    """Merge one batch of nodes for each set of store directories into the graph.

    A node that the graph already holds stays as it is, byte for byte. A store
    directory is content-addressed and write-once, thus its metadata cannot
    change, and a second read gives the same node.

    The emitter derives the order again over the whole graph, because a node of
    this batch can head a name that the graph already holds.

    Each batch resolves its edges INSIDE itself, thus a batch that is not closed
    leaves an edge under its bare name and the gate stops the run. That is the
    check the caller wants: a farm closure and an install closure are each closed
    by construction, and one that is not is a defect that must not publish.
    """
    graph = read_graph(store_root)
    nodes: dict[str, dict] = graph["nodes"]
    before = len(nodes)
    env = marker_environment()
    for batch in batches:
        for key, node in collect(batch, env).items():
            nodes.setdefault(key, node)
    gate(nodes)
    graph["by_name"] = order_by_name(nodes)
    write_graph(store_root, graph)
    log(f"{len(nodes)} node(s) in {GRAPH_NAME} ({len(nodes) - before} added)")
    return graph


def append_store_dirs(store_root: Path, store_dirs: list[Path]) -> dict:
    """Append one node for each store directory to the graph, and write the graph.

    This is what an acquisition run that builds no farm commits: the run resolved
    the whole closure of its specs and wrote it into the pool, thus the store
    directories themselves are the batch and no farm has to exist for the graph
    to learn them.
    """
    return _merge(store_root, [store_dirs])


def append(store_root: Path, farms: list[Path]) -> dict:
    """Append the closure of each farm to the graph, and write the graph."""
    return _merge(store_root, [farm_closure(farm, store_root) for farm in farms])


def append_for_farm(store_root: Path, farm: Path) -> dict:
    """Append the closure of one farm to the graph at the store root."""
    return append(store_root, [farm])


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Publish the dependency graph of the package store as deps.json.")
    ap.add_argument("--store-root", default=os.environ.get("LIB_ROOT", "/mnt/libs"),
                    help="the store root, which holds store/ and farms/")
    ap.add_argument("--farm", action="append", metavar="NAME",
                    help="a farm to append; repeat for more than one; "
                         "the default is every farm of the store")
    args = ap.parse_args()

    store_root = Path(args.store_root)
    farms_root = store_root / "farms"
    if args.farm:
        farms = [farms_root / name for name in args.farm]
    elif farms_root.is_dir():
        farms = [p for p in sorted(farms_root.iterdir())
                 if p.is_dir() and not p.name.startswith(".")]
    else:
        farms = []
    append(store_root, farms)
    return 0


if __name__ == "__main__":
    sys.exit(main())
