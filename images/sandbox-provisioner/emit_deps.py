#!/usr/bin/env python3
"""Publish the dependency graph of the package store as deps.json.

The graph is one file at the store root. A node is one store directory, and the
name of that directory is the key of the node. A node carries its track, its
import names, its entry points, and, for an R package, the name of the inner
directory. An edge names another node exactly. The graph holds no version range,
because pip and pak resolve each constraint at build time.

The unit of work is a resolved set, which is the closure of one farm. The emitter
resolves each edge inside that set. Thus two farms that hold two versions of one
package give two nodes, and each edge lands on the version of its own farm.

Python nodes come from importlib.metadata. Each environment marker evaluates in
this image, thus a marker gives its runtime truth. No extra is active, thus a
requirement under `extra == "test"` drops. R nodes come from the DESCRIPTION
fields Depends, Imports, and LinkingTo, which one Rscript call reads with
read.dcf.

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
from pathlib import Path

# The graph, at the store root. The name is part of the store contract, because a
# consumer reads the closure from it.
GRAPH_NAME = "deps.json"

# The schema version of the graph. A reader checks it before it trusts a field.
GRAPH_VERSION = 1

# The packages that the image owns, recorded beside the emitter.
BASE_PACKAGES_FILE = Path(__file__).with_name("base-packages.json")

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
    'fields <- c("Depends", "Imports", "LinkingTo"); '
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


def canon(name: str) -> str:
    """PEP 503 normalized distribution name.

    provision.py holds the same rule. The emitter keeps its own copy, because
    provision.py imports the emitter, and an import in the other direction would
    make a cycle.
    """
    return re.sub(r"[-_.]+", "-", name).lower()


# --- Environment markers ------------------------------------------------------
# A marker is a small boolean expression over a fixed set of variables. The
# emitter reads it with its own parser, because the provisioner image carries no
# packaging library, and the emitter must run with the standard library alone.


class MarkerError(Exception):
    """The emitter cannot read an environment marker."""


_TOKENS = re.compile(
    r"""\s*(?:
          (?P<string>'[^']*'|"[^"]*")
        | (?P<op>===|==|!=|<=|>=|~=|<|>)
        | (?P<punct>[()])
        | (?P<word>[A-Za-z_][A-Za-z0-9_.]*)
        )""",
    re.VERBOSE,
)

_NUMBER = re.compile(r"^(\d+)")


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


def _tokenize(text: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    pos = 0
    while pos < len(text):
        match = _TOKENS.match(text, pos)
        if match is None:
            if not text[pos:].strip():
                break
            raise MarkerError(f"cannot read the marker at {text[pos:]!r}")
        pos = match.end()
        kind = match.lastgroup or ""
        tokens.append((kind, match.group(kind)))
    return tokens


def _version_key(text: str) -> list[int]:
    """The numeric parts of a version, for an ordered comparison.

    A marker compares a version such as `3.10` against a variable such as
    `python_version`. A text comparison puts `3.10` before `3.9`, thus the
    comparison must read the numbers. A part that starts with no digit stops the
    read, and the caller then falls back to a text comparison.
    """
    key: list[int] = []
    for part in text.split("."):
        match = _NUMBER.match(part)
        if match is None:
            raise MarkerError(f"{text!r} is not a version")
        key.append(int(match.group(1)))
    return key


def _pad(left: list[int], right: list[int]) -> tuple[list[int], list[int]]:
    width = max(len(left), len(right))
    return left + [0] * (width - len(left)), right + [0] * (width - len(right))


def _order(left, right, op: str) -> bool:
    if op == "<":
        return left < right
    if op == "<=":
        return left <= right
    if op == ">":
        return left > right
    if op == ">=":
        return left >= right
    raise MarkerError(f"unknown marker operator {op!r}")


def _apply(left: str, op: str, right: str) -> bool:
    if op == "in":
        return left in right
    if op == "not in":
        return left not in right
    if op in ("==", "==="):
        return left == right
    if op == "!=":
        return left != right
    if op == "~=":
        # A compatible release: at least the named version, and the same version up
        # to the last part of the named one.
        prefix = len(_version_key(right)) - 1
        have, want = _pad(_version_key(left), _version_key(right))
        return have >= want and have[:prefix] == want[:prefix]
    try:
        have, want = _pad(_version_key(left), _version_key(right))
    except MarkerError:
        return _order(left, right, op)
    return _order(have, want, op)


class _Marker:
    """A recursive-descent reader of one marker expression."""

    def __init__(self, tokens: list[tuple[str, str]], env: dict[str, str]) -> None:
        self.tokens = tokens
        self.env = env
        self.at = 0

    def value(self) -> bool:
        result = self._or()
        if self.at != len(self.tokens):
            raise MarkerError(f"the marker has text after its end: {self.tokens[self.at:]!r}")
        return result

    def _peek(self) -> tuple[str, str] | None:
        return self.tokens[self.at] if self.at < len(self.tokens) else None

    def _take(self) -> tuple[str, str]:
        token = self._peek()
        if token is None:
            raise MarkerError("the marker stops too early")
        self.at += 1
        return token

    def _or(self) -> bool:
        result = self._and()
        while self._peek() == ("word", "or"):
            self._take()
            result = self._and() or result
        return result

    def _and(self) -> bool:
        result = self._atom()
        while self._peek() == ("word", "and"):
            self._take()
            result = self._atom() and result
        return result

    def _atom(self) -> bool:
        if self._peek() == ("punct", "("):
            self._take()
            result = self._or()
            if self._take() != ("punct", ")"):
                raise MarkerError("the marker has no closing parenthesis")
            return result
        return self._compare()

    def _operand(self) -> str:
        kind, text = self._take()
        if kind == "string":
            return text[1:-1]
        if kind == "word":
            if text not in self.env:
                raise MarkerError(f"unknown marker variable {text!r}")
            return self.env[text]
        raise MarkerError(f"{text!r} is not a marker operand")

    def _compare(self) -> bool:
        left = self._operand()
        kind, text = self._take()
        if kind == "op":
            op = text
        elif (kind, text) == ("word", "in"):
            op = "in"
        elif (kind, text) == ("word", "not"):
            if self._take() != ("word", "in"):
                raise MarkerError("the marker has `not` without `in`")
            op = "not in"
        else:
            raise MarkerError(f"{text!r} is not a marker operator")
        right = self._operand()
        return _apply(left, op, right)


def marker_is_true(text: str, env: dict[str, str]) -> bool:
    """Read one environment marker against `env`."""
    return _Marker(_tokenize(text), env).value()


def edge_name(requirement: str, env: dict[str, str]) -> str | None:
    """The distribution name of `requirement`, or None when its marker is false.

    A marker that the emitter cannot read keeps the edge, and it reports the
    marker. A kept edge that names no node stops the build with the name of the
    edge, but a dropped edge would leave the closure short with no report.
    """
    body, _, marker = requirement.partition(";")
    match = REQUIREMENT_NAME.match(body)
    if match is None:
        return None
    name = match.group(1)
    if marker.strip():
        try:
            if not marker_is_true(marker, env):
                return None
        except MarkerError as exc:
            log(f"WARNING: {exc}; the emitter keeps the edge to {name}")
    return name


# --- The nodes ----------------------------------------------------------------


def load_base_packages() -> dict[str, set[str]]:
    """The image-owned package names, by track, from the file beside the emitter."""
    try:
        record = json.loads(BASE_PACKAGES_FILE.read_text())
    except (OSError, ValueError) as exc:
        raise SystemExit(f"[deps] cannot read the base package list {BASE_PACKAGES_FILE}: {exc}")
    return {
        "python": {canon(name) for name in record.get("python", [])},
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
        return sorted({line.strip() for line in recorded.splitlines() if line.strip()})
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
    return sorted(names)


def entry_point_names(dist: Distribution) -> list[str]:
    """The command names that a Python distribution installs."""
    try:
        points = list(dist.entry_points)
    except (OSError, ValueError):
        return []
    return sorted({point.name for point in points if point.group in SCRIPT_GROUPS})


def r_fields(inner_dirs: list[Path]) -> dict[str, list[str]]:
    """The Depends, Imports, and LinkingTo names of each installed R package.

    One Rscript call reads every DESCRIPTION, thus the emitter starts R one time
    for a whole closure. Each entry can carry a version constraint in parentheses,
    and this function removes it to keep the bare name.
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
    no node. Each edge that names no node of the set, and no image-owned package,
    stays in the graph under its bare name. The gate then names it.
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
            name = _metadata_name(dist) or fallback
            nodes[key] = {
                "track": "python",
                "imports": import_names(store_dir, dist),
                "entry_points": entry_point_names(dist),
            }
            index["python"][canon(name)] = key
            wanted[key] = ("python",
                           [n for n in (edge_name(req, env) for req in _requirements(dist))
                            if n])
            continue
        inner = r_package_of(store_dir)
        if inner is not None:
            nodes[key] = {
                "track": "r",
                "imports": [inner.name],
                "entry_points": [],
                "r_dir": inner.name,
            }
            index["r"][inner.name] = key
            r_inner[key] = inner

    fields = r_fields(sorted(r_inner.values()))
    for key, inner in r_inner.items():
        wanted[key] = ("r", fields.get(str(inner), []))

    for key, (track, names) in wanted.items():
        edges = set()
        for name in names:
            target = index[track].get(canon(name) if track == "python" else name)
            if target is None:
                if (canon(name) if track == "python" else name) in base[track]:
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
    """The published graph, or an empty graph when the store carries none."""
    path = store_root / GRAPH_NAME
    try:
        graph = json.loads(path.read_text())
    except (OSError, ValueError):
        return {"version": GRAPH_VERSION, "nodes": {}}
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), dict):
        return {"version": GRAPH_VERSION, "nodes": {}}
    graph["version"] = GRAPH_VERSION
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


def gate(nodes: dict[str, dict]) -> None:
    """Stop the build when an edge names a node that the graph does not hold."""
    bad = dangling_edges(nodes)
    if not bad:
        return
    lines = "\n".join(f"  {key} -> {edge}" for key, edge in bad)
    raise SystemExit(
        f"[deps] {len(bad)} edge(s) name a node that the graph does not hold. "
        f"The closure is short, or the marker of the requirement read wrong:\n{lines}")


def _merge(store_root: Path, batches: list[list[Path]]) -> dict:
    """Merge one batch of nodes for each set of store directories into the graph.

    A node that the graph already holds stays as it is, byte for byte. A store
    directory is content-addressed and write-once, thus its metadata cannot
    change, and a second read gives the same node.

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
