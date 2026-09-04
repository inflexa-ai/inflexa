#!/usr/bin/env python3
"""The per-arch coverage report of the package-store build.

After the load check, the build reports, per track: the wanted names (the
manifest entries), the loaded names, and the missing names. A wanted name
counts as loaded in two cases: the farm lock holds it (each entry of the
lock loaded in the check before this report), or the R library of the
sandbox image loaded it (the base and recommended packages of R, which the
store never holds). One missing wanted name fails the build. The report
compares against nothing older: a regression is a missing wanted name, and
this rule catches it with no baseline.

Usage:
    package-store-coverage.py --manifest <manifest.yaml> --lock <inflexa.lock>
        [--r-base-loaded <one R package name per line, as the image loaded them>]
        --arch <amd64|arm64> [--summary <path of the step summary>]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import yaml

R_TRACKS = ("cran", "bioconductor", "github")
TRACKS = ("python",) + R_TRACKS


def canon(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def gh_canon(name: str) -> str:
    """The github comparison space: letters and digits alone, in lower case.

    A github manifest entry names a repository, and the installed package
    names itself in its DESCRIPTION. The two agree only loosely
    (seurat-disk installs SeuratDisk). Thus both sides normalize with the
    rule of `_github_wanted_names` in the provisioner.
    """
    return re.sub(r"[^a-z0-9]", "", name.lower())


def github_tail(raw) -> str | None:
    """The repository tail of one github entry (`owner/repo@ref` gives `repo`)."""
    if isinstance(raw, dict):
        raw = raw.get("name")
    if not isinstance(raw, str) or not raw.strip():
        return None
    return raw.strip().split("/")[-1].split("@")[0]


def entry_name(raw) -> str | None:
    if isinstance(raw, str):
        match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)", raw.strip())
        return match.group(1) if match else None
    if isinstance(raw, dict):
        return str(raw.get("name")) if raw.get("name") else None
    return None


def wanted_by_track(manifest: dict, arch: str, gh_display: dict[str, str]) -> dict[str, set[str]]:
    """The manifest names per track, canonicalized per its ecosystem."""
    pip = (manifest.get("python") or {}).get("pip") or {}
    python = {canon(n) for raw in list(pip.get("common") or []) + list(pip.get(arch) or [])
              if (n := entry_name(raw))}
    r = manifest.get("r") or {}
    out = {"python": python}
    for track in ("cran", "bioconductor"):
        out[track] = {n for raw in r.get(track) or [] if (n := entry_name(raw))}
    # A github entry names a repository, not a package. The wanted name is
    # the normalized repository tail, and loaded_names normalizes the lock
    # side the same way. The entry_name regex stops at the slash, thus it
    # would name the OWNER, and the gate would go blind for the track.
    out["github"] = set()
    for raw in r.get("github") or []:
        if (tail := github_tail(raw)):
            key = gh_canon(tail)
            out["github"].add(key)
            gh_display.setdefault(key, tail)
    # The git track names install under their package name; the manifest
    # entries carry `name` beside the url.
    out["bioconductor"] |= {n for raw in r.get("git") or [] if (n := entry_name(raw))}
    return out


def loaded_names(lock: dict, r_base_loaded: set[str], gh_display: dict[str, str]) -> dict[str, set[str]]:
    """The loaded names, in the comparison space of each manifest track.

    Python compares in the PEP 503 fold. The three R subtrees share one
    library path, and the subtree of a package is the closure that placed
    it: gen-r-lock.R puts the closure of the CRAN refs in r/cran and the
    rest in r/bioconductor, and the github stage keeps its own closure. A
    Bioconductor entry of the manifest thus lands in r/cran when a CRAN
    package reaches it first. One R set serves the three tracks: the
    DESCRIPTION spelling for cran and bioconductor entries, the gh_canon
    space for github entries. The R packages that the image loaded join
    the set, because the manifest names recommended packages that no
    subtree holds.
    """
    python: set[str] = set()
    r_names: set[str] = set(r_base_loaded)
    for pkg in lock.get("packages") or []:
        track = pkg.get("track")
        name = pkg.get("name")
        if not track or not name:
            continue
        if track == "python":
            python.add(canon(name))
        elif track in R_TRACKS:
            r_names.add(name)
    github: set[str] = set()
    for name in r_names:
        key = gh_canon(name)
        gh_display.setdefault(key, name)
        github.add(key)
    return {"python": python, "cran": r_names, "bioconductor": r_names, "github": github}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--lock", required=True)
    ap.add_argument("--r-base-loaded", default=None,
                    help="one R package name per line: the packages of the sandbox image that loaded")
    ap.add_argument("--arch", required=True)
    ap.add_argument("--summary", default=None)
    args = ap.parse_args()

    manifest = yaml.safe_load(Path(args.manifest).read_text()) or {}
    lock = json.loads(Path(args.lock).read_text())
    r_base_loaded = set()
    if args.r_base_loaded:
        r_base_loaded = {line.strip() for line in Path(args.r_base_loaded).read_text().splitlines() if line.strip()}

    # The github sets compare in the gh_canon space, and the report prints
    # the spelling of the source through this map (manifest tail first).
    gh_display: dict[str, str] = {}
    wanted = wanted_by_track(manifest, args.arch, gh_display)
    loaded = loaded_names(lock, r_base_loaded, gh_display)

    def disp(track: str, name: str) -> str:
        return gh_display.get(name, name) if track == "github" else name

    lines = [f"## Package-store coverage ({args.arch})", "", "| Track | Wanted | Loaded | Missing |", "|-|-|-|-|"]
    missing_all: list[str] = []
    for track in TRACKS:
        want = wanted.get(track, set())
        have = loaded.get(track, set())
        missing = sorted(disp(track, n) for n in want - have)
        lines.append(f"| {track} | {len(want)} | {len(want & have)} | {len(missing)} |")
        if missing:
            lines.append(f"| | | | {', '.join(missing)} |")
            missing_all.extend(f"{track}/{name}" for name in missing)

    if missing_all:
        lines.append("")
        lines.append(f"MISSING: wanted by the manifest, loaded by nothing: {', '.join(missing_all)}")

    text = "\n".join(lines) + "\n"
    print(text)
    if args.summary:
        with open(args.summary, "a") as handle:
            handle.write(text)
    if missing_all:
        print(f"::error::{len(missing_all)} wanted package(s) did not load: {', '.join(missing_all)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
