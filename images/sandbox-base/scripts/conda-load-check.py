#!/usr/bin/env python3
"""Write the JSON inventory fragment of the conda track.

The probe decides presence: a manifest tool whose binary resolves on PATH
goes into the fragment, and a tool that does not resolve drops with a log
line. Zero recorded tools fail the build. A tool on PATH whose package has
no version in the prefix fails the build too. The manifest then names a
package that the prefix does not hold, and a silent drop would narrow the
advertised set with no signal.

The probe reads the BINARY name, not the raw manifest entry. An entry can
carry a conda pin (`samtools=1.22.1`), and a package can install its
executable under another name. The `binaries` map of the manifest holds the
exceptions. A probe of the raw entry drops a tool that works.

Each entry carries the conda package `name` and its `version`. The version
comes from `micromamba list --json` over the prefix, keyed on the package
name. The entry carries the `executable` only when the binary name differs
from the package name.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

import yaml


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default="/tmp/manifest.yaml")
    parser.add_argument("--prefix", default="/opt/conda")
    parser.add_argument("--out", default="/tmp/conda.packages.json")
    parser.add_argument("--micromamba", default="micromamba")
    return parser.parse_args()


def manifest_tools(manifest, arch):
    """Return the package names of the arch, and the package-to-binary map."""
    with open(manifest) as f:
        group = yaml.safe_load(f)["system_tools"]
    specs = group["common"] + group.get(arch, [])
    names = [re.split(r"[=<>!~\s]", s.strip(), maxsplit=1)[0] for s in specs]
    return names, group.get("binaries") or {}


def prefix_versions(micromamba, prefix):
    """Return the map of the package name to the version of the prefix."""
    result = subprocess.run(
        [micromamba, "list", "-p", prefix, "--json"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"`{micromamba} list -p {prefix} --json` gave "
            f"{result.returncode}: {result.stderr.strip()}"
        )
    payload = json.loads(result.stdout)
    # micromamba 2.x prints an object, with the list under `packages`. An
    # older release prints the bare list, thus both shapes read here.
    if isinstance(payload, dict):
        payload = payload.get("packages") or payload.get("result") or []
    versions = {}
    for entry in payload:
        name = entry.get("name")
        version = entry.get("version")
        if name and version:
            versions[str(name)] = str(version)
    return versions


def main():
    args = parse_args()
    arch = os.environ.get("TARGETARCH", "amd64")
    names, binaries = manifest_tools(args.manifest, arch)

    try:
        versions = prefix_versions(args.micromamba, args.prefix)
    except (OSError, RuntimeError, ValueError) as error:
        print(
            f"ERROR: the version read of the prefix {args.prefix} failed: {error}",
            file=sys.stderr,
        )
        return 1

    tools = []
    dropped = []
    unversioned = []
    for name in sorted(set(names)):
        binary = binaries.get(name, name)
        if shutil.which(binary) is None:
            print(f"DROP: {binary} not found on PATH")
            dropped.append(binary)
            continue
        version = versions.get(name)
        if version is None:
            print(
                f"ERROR: {binary} is on PATH, but the package {name} has no "
                f"version in the prefix {args.prefix}",
                file=sys.stderr,
            )
            unversioned.append(name)
            continue
        entry = {"name": name, "version": version}
        if binary != name:
            entry["executable"] = binary
        print(f"  OK: {binary} {version}")
        tools.append(entry)

    if unversioned:
        print(
            "ERROR: the manifest names package(s) that the prefix does not "
            "hold: " + " ".join(unversioned) + " — failing the build.",
            file=sys.stderr,
        )
        return 1

    with open(args.out, "w") as f:
        json.dump(tools, f, indent=2)
        f.write("\n")

    if dropped:
        print("NOTE: system tool(s) dropped: " + " ".join(dropped))
    if not tools:
        print(
            "ERROR: the conda track resolved ZERO tools (non-empty floor) "
            "— failing the build.",
            file=sys.stderr,
        )
        return 1
    print(f"Load check OK: {len(tools)}/{len(names)} system tool(s) resolved")
    return 0


if __name__ == "__main__":
    sys.exit(main())
