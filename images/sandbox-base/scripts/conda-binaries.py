#!/usr/bin/env python3
"""Print the probe name of each conda tool, one per line.

The probe reads the BINARY name, not the manifest entry. An entry can carry
a conda pin (`samtools=1.22.1`), and a package can install its executable
under another name. The `binaries` map of the manifest holds the exceptions.
"""
import os
import re
import sys

import yaml

manifest = sys.argv[1] if len(sys.argv) > 1 else "/tmp/manifest.yaml"
with open(manifest) as f:
    group = yaml.safe_load(f)["system_tools"]
binaries = group.get("binaries") or {}
arch = os.environ.get("TARGETARCH", "amd64")
specs = group["common"] + group.get(arch, [])
names = [re.split(r"[=<>!~\s]", s.strip(), maxsplit=1)[0] for s in specs]
print("\n".join(binaries.get(n, n) for n in names))
