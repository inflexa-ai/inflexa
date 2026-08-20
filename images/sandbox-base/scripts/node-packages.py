#!/usr/bin/env python3
"""Print the node package set of the manifest, space-joined."""
import sys

import yaml

manifest = sys.argv[1] if len(sys.argv) > 1 else "/tmp/manifest.yaml"
with open(manifest) as f:
    print(" ".join(yaml.safe_load(f)["node"]))
