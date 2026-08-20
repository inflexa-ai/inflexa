#!/usr/bin/env python3
"""Print the conda tool set of the manifest, space-joined.

The set is `common` plus the list of the target arch. TARGETARCH comes from
the build environment, and amd64 is the default.
"""
import os
import sys

import yaml

manifest = sys.argv[1] if len(sys.argv) > 1 else "/tmp/manifest.yaml"
with open(manifest) as f:
    group = yaml.safe_load(f)["system_tools"]
arch = os.environ.get("TARGETARCH", "amd64")
print(" ".join(group["common"] + group.get(arch, [])))
