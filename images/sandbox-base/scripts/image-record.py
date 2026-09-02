#!/usr/bin/env python3
"""Assemble the baked inventory record of the image.

The record is the one description that the image gives of itself. It joins
the two builder fragments with the identity of the image and the versions of
the three runtimes. The store build copies the file verbatim, thus one writer
owns the shape.

The script runs in the runtime stage. That stage has the system python3 and
no third-party module, thus the script uses the standard library only.
"""
import argparse
import json
import subprocess
import sys

SCHEMA = 1
REPOSITORY = "ghcr.io/inflexa-ai/sandbox-base"

# Each runtime prints its version on the first line, behind a prefix.
RUNTIMES = {
    "python": (["python3", "--version"], "Python "),
    "r": (["R", "--version"], "R version "),
    "node": (["node", "--version"], "v"),
}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="the IMAGE_VERSION build arg")
    parser.add_argument("--arch", required=True, help="the TARGETARCH build arg")
    parser.add_argument("--system-tools", default="/opt/inflexa/conda.packages.json")
    parser.add_argument("--node", default="/opt/inflexa/node.packages.json")
    parser.add_argument("--out", default="/opt/inflexa/image-packages.json")
    return parser.parse_args()


def runtime_version(command, prefix):
    """Return the bare version number that the command prints."""
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(
            f"`{' '.join(command)}` gave {result.returncode}: {result.stderr.strip()}"
        )
    text = result.stdout or result.stderr
    line = text.splitlines()[0].strip()
    if line.startswith(prefix):
        line = line[len(prefix) :]
    return line.split()[0]


def fragment(path):
    """Return the entry list of a builder fragment."""
    with open(path) as f:
        entries = json.load(f)
    if not isinstance(entries, list):
        raise ValueError(f"{path} does not hold a list")
    return entries


def main():
    args = parse_args()
    if not args.version or not args.arch:
        print("ERROR: the version and the arch must both be set.", file=sys.stderr)
        return 1

    try:
        record = {
            "schema": SCHEMA,
            "image": {
                "repository": REPOSITORY,
                "version": args.version,
                "arch": args.arch,
            },
            "runtimes": {
                name: runtime_version(command, prefix)
                for name, (command, prefix) in RUNTIMES.items()
            },
            "system_tools": fragment(args.system_tools),
            "node": fragment(args.node),
        }
    except (OSError, RuntimeError, ValueError) as error:
        print(f"ERROR: the record assembly failed: {error}", file=sys.stderr)
        return 1

    text = json.dumps(record, indent=2) + "\n"
    with open(args.out, "w") as f:
        f.write(text)
    print(text, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
