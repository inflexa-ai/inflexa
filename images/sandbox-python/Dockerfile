# syntax=docker/dockerfile:1
# sandbox-python — sandbox-base + the Python libraries, the bioconda CLI tools,
# and the Node packages. Everything installs into /mnt/libs/current/… — the SAME
# paths the managed read-only mount uses — so a baked image and a mounted store
# present a byte-identical runtime layout and the harness lib-store runtime
# contract does not change.
#
# Multi-stage: throwaway `*-builder` stages carry the build toolchain (compilers,
# -dev headers, micromamba) and install each track into /mnt/libs/current; the
# final runtime stage is `FROM sandbox-base` and only COPYs the finished subtrees
# in, so the published image stays lean (no build toolchain, no -dev headers).
#
# Each builder stage runs a best-effort LOAD CHECK: it import()/require()/
# `--version`s each installed package and derives that track's packages.txt
# fragment from the set that actually loaded. A single package's load failure
# drops it from the fragment; a track that loaded ZERO packages fails the build
# (the non-empty floor), so a degenerate/empty tarball is never shipped.
#
# Build context is the repo ROOT (so COPY can reach images/lib-store-manifest.yaml).

# The published lean runtime this image layers onto. CI overrides it with the
# locally-built/loaded tag; the default is the GHCR-published base.
ARG SANDBOX_BASE_IMAGE=ghcr.io/inflexa-ai/sandbox-base:latest
# Builder base — MUST match sandbox-base's own base so the compiled Python
# extensions and their .so ABI match the runtime (system Python 3.12).
ARG BASE_IMAGE=rocker/r-ver:4.6.0

# The store root every layer installs into and every resolver env derives from.
ARG INFLEXA_LIB_ROOT=/mnt/libs/current

# Target arch (auto-set by buildx). Used to arch-gate the runtime's numba target.
ARG TARGETARCH

# =============================================================================
# Stage: toolchain — build deps, package managers, the manifest, the load-check
# helpers. The python/conda/node builder stages all branch from it.
# =============================================================================
FROM ${BASE_IMAGE} AS toolchain
ARG INFLEXA_LIB_ROOT

# Build toolchain + dev headers (Python C extensions, some conda-built wheels).
# The apt build-dep set + retry config is shared with sandbox-python-r's R
# toolchain stage; see the script header for the apt-retry rationale.
COPY images/install-build-toolchain.sh /tmp/install-build-toolchain.sh
RUN bash /tmp/install-build-toolchain.sh

# Node.js 20 for npm packages
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# uv for fast pip installs (pinned to match sandbox-base's uv so resolver/wheel
# behavior is identical across the base and this builder). Build-only: never
# reaches the runtime stage, so ARG rather than ENV.
ARG UV_VERSION=0.7.12
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv

# pyyaml for reading the manifest (use uv, not pip — pip's apt postinst fails under QEMU)
RUN uv pip install --system --break-system-packages --no-cache pyyaml

COPY images/lib-store-manifest.yaml /tmp/manifest.yaml

# Store subtree layout — identical to the managed mount's.
RUN mkdir -p ${INFLEXA_LIB_ROOT}/python/site-packages ${INFLEXA_LIB_ROOT}/node ${INFLEXA_LIB_ROOT}/conda

# Best-effort Python load check — imports each manifest package, writes the
# fragment from the set that imported, and enforces the non-empty floor (fail
# only when ZERO imported). Import module names are derived from installed dist
# metadata (top_level.txt / RECORD), so no hand-maintained pip->import alias map
# is needed — the same derivation is reused by the acceptance validator.
RUN <<'PYEOF' cat > /usr/local/bin/lib-store-py-loadtest.py
#!/usr/bin/env python3
"""Best-effort Python load check: import each manifest pip package and write the
packages.txt fragment from the set that imported. A single import failure drops
that package (best-effort); a track that imported ZERO packages fails the build
(the non-empty floor)."""
import importlib
import importlib.metadata as im
import os
import re
import sys

import yaml

FRAG = os.environ["FRAGMENT_OUT"]


def canonical(spec: str) -> str:
    """pip spec -> canonical distribution name (strip version/extras/markers)."""
    return re.split(r"[<>=!~;\[\s]", spec.strip())[0]


def modules_for(dist: str) -> list[str]:
    """Top-level import module names for an installed distribution."""
    try:
        d = im.distribution(dist)
    except im.PackageNotFoundError:
        return []
    txt = d.read_text("top_level.txt")
    mods = [l.strip() for l in txt.splitlines() if l.strip() and not l.startswith("_")] if txt else []
    if not mods:
        seen = set()
        for f in d.files or []:
            parts = f.parts
            if len(parts) == 1 and parts[0].endswith(".py") and not parts[0].startswith("_"):
                seen.add(parts[0][:-3])
            elif len(parts) >= 2 and parts[1] == "__init__.py":
                top = parts[0]
                if top and not top.startswith("_") and not top.endswith((".dist-info", ".data")):
                    seen.add(top)
        mods = sorted(seen)
    if not mods:
        # Namespace/meta dist (e.g. rpy2, whose code lives in the rpy2-rinterface /
        # rpy2-robjects sub-dists): no top_level.txt and no own top-level module
        # files, but the dist name itself is the importable namespace. Fall back to
        # it — a genuinely-missing package then fails at the real import, not here.
        mods = [dist.replace("-", "_")]
    return mods


# Resolve the same `common + <arch>` set the installer used, so the load check
# tests exactly what was installed for this architecture.
pip = yaml.safe_load(open("/tmp/manifest.yaml"))["python"]["pip"]
specs = pip["common"] + pip.get(os.environ.get("TARGETARCH", "amd64"), [])
loaded: list[str] = []
failed: list[str] = []
for spec in specs:
    name = canonical(spec)
    if not name:
        continue
    mods = modules_for(name)
    if not mods:
        print(f"DROP {name}: no import module found (not installed?)")
        failed.append(name)
        continue
    last = ""
    for mod in mods:
        try:
            importlib.import_module(mod)
            print(f"  OK: {name}")
            loaded.append(name)
            break
        except Exception as e:  # noqa: BLE001 - any import error is a load failure
            last = f"{mod}: {type(e).__name__}: {e}"
    else:
        print(f"DROP {name}: {last}")
        failed.append(name)

with open(FRAG, "w") as fh:
    fh.write("## Python (pip)\n" + ", ".join(sorted(loaded)) + "\n")

if failed:
    print(f"NOTE: {len(failed)} Python package(s) did not import and were dropped: {', '.join(failed)}")
if not loaded:
    print("ERROR: the python track loaded ZERO packages (non-empty floor) — failing the build.")
    sys.exit(1)
print(f"Load check OK: {len(loaded)}/{len(specs)} Python package(s) imported")
PYEOF

# =============================================================================
# Stage: python-builder — Python packages via uv into the store's site-packages.
# =============================================================================
FROM toolchain AS python-builder
ARG INFLEXA_LIB_ROOT
ARG TARGETARCH

# --python pins uv to system Python so .so suffixes match the sandbox runtime.
# The pip set is `common + <arch>` — the manifest decides the arch split (e.g.
# liana[extras] on amd64 vs core liana on arm64); the builder just applies it.
RUN python3 -c "\
import yaml, os; \
pip = yaml.safe_load(open('/tmp/manifest.yaml'))['python']['pip']; \
pkgs = pip['common'] + pip.get(os.environ.get('TARGETARCH', 'amd64'), []); \
print('\n'.join(pkgs))" > /tmp/requirements.txt 2>/dev/null || true \
    && if [ -s /tmp/requirements.txt ]; then \
       uv pip install --python /usr/bin/python3 --break-system-packages --no-cache \
         --target ${INFLEXA_LIB_ROOT}/python/site-packages \
         -r /tmp/requirements.txt; \
    fi

RUN PYTHONPATH=${INFLEXA_LIB_ROOT}/python/site-packages python3 -c "\
from rpds.rpds import *; print('rpds OK'); \
import jsonschema; print('jsonschema OK'); \
import nbformat; print('nbformat OK')" \
    && echo "Python smoke tests passed"

# Pre-warm numba JIT cache, matplotlib font cache, and heavy import chains INTO
# the store (site-packages/matplotlib_config, numba caches). Without this,
# `import scanpy` takes 10-20 min on first run because numba compiles its
# internals — and the store is read-only at runtime, so the cache can never be
# written then. Each import runs independently so one LLVM/JIT crash doesn't
# block the rest.
# On arm64, pin numba/LLVM to a generic CPU model. Autodetecting the host CPU
# crashes LLVM codegen on newer arm64 cores its scheduling model doesn't yet cover;
# a generic target is portable across all arm64 CPUs. The runtime image must set the
# same value so the baked JIT cache stays hit-compatible.
RUN PYTHONPATH=${INFLEXA_LIB_ROOT}/python/site-packages \
    MPLCONFIGDIR=${INFLEXA_LIB_ROOT}/python/site-packages/matplotlib_config \
    bash -c '\
    if [ "$(uname -m)" = aarch64 ]; then export NUMBA_CPU_NAME=generic; fi; \
    ok=0; fail=0; \
    for pkg in numba matplotlib scanpy seaborn pertpy scvi cell2location; do \
      if python3 -c "import $pkg; print(f\"$pkg OK\")" 2>&1; then \
        ok=$((ok+1)); \
      else \
        echo "WARN: $pkg warm-up failed (non-fatal)"; \
        fail=$((fail+1)); \
      fi; \
    done; \
    echo "Cache warm-up: $ok OK, $fail failed"; \
    '

RUN if [ "$(uname -m)" = aarch64 ]; then export NUMBA_CPU_NAME=generic; fi; \
    PYTHONPATH=${INFLEXA_LIB_ROOT}/python/site-packages \
    MPLCONFIGDIR=${INFLEXA_LIB_ROOT}/python/site-packages/matplotlib_config \
    FRAGMENT_OUT=${INFLEXA_LIB_ROOT}/python.packages.txt \
    python3 /usr/local/bin/lib-store-py-loadtest.py

# =============================================================================
# Stage: conda-builder — bioinformatics CLI tools via bioconda into the store's
# conda prefix. Installed directly at the runtime mount path so conda writes
# correct absolute shebangs and paths — no post-build rewriting.
# =============================================================================
FROM toolchain AS conda-builder
ARG INFLEXA_LIB_ROOT
ARG TARGETARCH

# micromamba (deterministic binary from the official image).
COPY --from=mambaorg/micromamba:2.5.0 /bin/micromamba /usr/local/bin/micromamba

# `common + <arch>` — the manifest decides the arch split (amd64-only tools have
# no linux-aarch64 bioconda build). Strict channel priority prevents mixed
# conda-forge/bioconda dependency conflicts.
RUN TOOLS=$(python3 -c "\
import yaml, os; \
g = yaml.safe_load(open('/tmp/manifest.yaml'))['system_tools']; \
print(' '.join(g['common'] + g.get(os.environ.get('TARGETARCH', 'amd64'), [])))" 2>/dev/null || true) \
    && if [ -n "$TOOLS" ]; then \
       micromamba create -y -p ${INFLEXA_LIB_ROOT}/conda \
         --channel-priority strict \
         -c conda-forge -c bioconda \
         $TOOLS; \
       micromamba clean --all --yes; \
    fi

# Best-effort load check — every manifest tool that resolves on PATH goes into
# the fragment (a canned --version call is logged for visibility); missing tools
# are dropped. Floor: zero resolved tools fails the build. PATH must include the
# conda bin so tools like fastqc find their bundled java — appended AFTER the
# system dirs so the load check's `python3` below stays the system 3.12 (which
# carries pyyaml), never conda's 3.11.
ENV PATH="${PATH}:${INFLEXA_LIB_ROOT}/conda/bin"
RUN TOOLS=$(python3 -c "\
import yaml, os; \
g = yaml.safe_load(open('/tmp/manifest.yaml'))['system_tools']; \
print('\n'.join(g['common'] + g.get(os.environ.get('TARGETARCH', 'amd64'), [])))" 2>/dev/null) \
    && ok=""; failed=""; \
    for tool in $TOOLS; do \
      if command -v "$tool" >/dev/null 2>&1; then \
        ver=$("$tool" --version 2>&1 | head -1 || true); \
        echo "  OK: $tool ${ver}"; ok="$ok $tool"; \
      else \
        echo "DROP: $tool not found on PATH"; failed="$failed $tool"; \
      fi; \
    done; \
    printf '## System tools (CLI)\n%s\n' "$(printf '%s\n' $ok | sort | paste -sd, - | sed 's/,/, /g')" \
      > ${INFLEXA_LIB_ROOT}/conda.packages.txt; \
    [ -n "$failed" ] && echo "NOTE: system tool(s) dropped:$failed"; \
    if [ -z "$(printf '%s' $ok)" ]; then echo "ERROR: the conda track resolved ZERO tools (non-empty floor) — failing the build."; exit 1; fi; \
    echo "Load check OK: system tools resolved"

# =============================================================================
# Stage: node-builder — Node.js packages into the store's node subtree.
# =============================================================================
FROM toolchain AS node-builder
ARG INFLEXA_LIB_ROOT

# The node package set is the manifest's flat `node:` list — parsed the same way
# the conda stage parses `system_tools`.
RUN NODE_PKGS=$(python3 -c "\
import yaml; \
print(' '.join(yaml.safe_load(open('/tmp/manifest.yaml'))['node']))" 2>/dev/null || true) \
    && cd ${INFLEXA_LIB_ROOT}/node && npm install $NODE_PKGS 2>&1 | tail -3

# Best-effort load check — require() each manifest node package; fragment from the
# set that loaded; floor if zero. (node/ carries the manifest's direct deps; their
# transitive deps live under node_modules but are not advertised.)
RUN NODE_PKGS=$(python3 -c "\
import yaml; \
print(' '.join(yaml.safe_load(open('/tmp/manifest.yaml'))['node']))" 2>/dev/null) \
    && cd ${INFLEXA_LIB_ROOT}/node \
    && FRAG="${INFLEXA_LIB_ROOT}/node.packages.txt" NODE_PKGS="$NODE_PKGS" node -e '\
const pkgs = (process.env.NODE_PKGS || "").split(/\s+/).filter(Boolean); \
const bad = []; \
for (const p of pkgs) { \
  try { require(p); console.log("  OK: " + p); } \
  catch (e) { console.log("DROP " + p + ": " + e.message); bad.push(p); } \
} \
const ok = pkgs.filter((p) => !bad.includes(p)); \
require("fs").writeFileSync(process.env.FRAG, "## Node (npm)\n" + ok.join(", ") + "\n"); \
if (bad.length) console.error("NOTE: " + bad.length + " Node package(s) dropped"); \
if (!ok.length) { console.error("ERROR: the node track loaded ZERO packages (non-empty floor)"); process.exit(1); } \
console.log("Load check OK: " + ok.length + "/" + pkgs.length + " Node package(s) loaded");'

# =============================================================================
# Stage: runtime — the lean published image. FROM sandbox-base; COPY the built
# subtrees + fragments in; bake the resolver env, the packages.txt, and the
# FROM-extension install targets. No build toolchain reaches this layer.
# =============================================================================
# arm64 gets a generic numba/LLVM CPU target baked in (see the warm-up note): the
# host-CPU autodetect crashes LLVM codegen on newer arm64 cores, and this value
# must match the build-time warm-up so the baked read-only JIT cache stays
# hit-compatible. amd64 keeps host autodetect. Arch-specific pass-through stages
# select the right one; only the stage for the target arch is built.
FROM ${SANDBOX_BASE_IMAGE} AS runtime-amd64
FROM ${SANDBOX_BASE_IMAGE} AS runtime-arm64
ENV NUMBA_CPU_NAME=generic
FROM runtime-${TARGETARCH} AS runtime
ARG INFLEXA_LIB_ROOT

# OCI metadata: link the package to its source repo and describe this layer.
LABEL org.opencontainers.image.source="https://github.com/inflexa-ai/inf-cli"
LABEL org.opencontainers.image.description="Inflexa sandbox with a baked Python 3.12 library store — pip packages, bioconda CLI tools, and Node — installed at /mnt/libs/current so a plain docker run resolves imports with no mount."

USER root

COPY --from=python-builder ${INFLEXA_LIB_ROOT}/python ${INFLEXA_LIB_ROOT}/python
COPY --from=python-builder ${INFLEXA_LIB_ROOT}/python.packages.txt ${INFLEXA_LIB_ROOT}/python.packages.txt
COPY --from=conda-builder ${INFLEXA_LIB_ROOT}/conda ${INFLEXA_LIB_ROOT}/conda
COPY --from=conda-builder ${INFLEXA_LIB_ROOT}/conda.packages.txt ${INFLEXA_LIB_ROOT}/conda.packages.txt
COPY --from=node-builder ${INFLEXA_LIB_ROOT}/node ${INFLEXA_LIB_ROOT}/node
COPY --from=node-builder ${INFLEXA_LIB_ROOT}/node.packages.txt ${INFLEXA_LIB_ROOT}/node.packages.txt

# The refresh helper — re-derives /mnt/libs/current/packages.txt from the present
# per-track fragments (and, for a FROM-extension image, from what is actually
# installed) so list_available_packages reflects the current store. Shipped on
# PATH so a downstream `FROM` image can call it after adding packages.
COPY images/sandbox-python/inflexa-libs-refresh /usr/local/bin/inflexa-libs-refresh
RUN chmod +x /usr/local/bin/inflexa-libs-refresh

# Bake the load-tested packages.txt from the fragments the builders produced.
# --from-fragments concatenates the per-track *.packages.txt fragments verbatim
# (the load-tested set), rather than re-deriving from the filesystem — so the
# baked file advertises exactly what passed the build's load check.
RUN INFLEXA_LIB_ROOT=${INFLEXA_LIB_ROOT} inflexa-libs-refresh --from-fragments

# --- Self-sufficiency: bake the package-resolver env so a plain `docker run`
# with NO harness and NO mount resolves imports for the baked packages. Because
# the baked and mounted paths are identical, this is redundant with — never in
# conflict with — the env the harness injects for the managed mount. The Python
# .pth already ships in sandbox-base; R_LIBS_SITE/NODE_PATH/PATH are added here.
# conda/bin goes LAST on PATH — matching the harness mount plan — so the system
# python 3.12 (which reads the store .pth) stays the default `python3`, not
# conda's 3.11, which cannot see the store's site-packages.
ENV R_LIBS_SITE="${INFLEXA_LIB_ROOT}/r/github:${INFLEXA_LIB_ROOT}/r/bioconductor:${INFLEXA_LIB_ROOT}/r/cran"
ENV NODE_PATH="${INFLEXA_LIB_ROOT}/node/node_modules"
ENV PATH="${PATH}:${INFLEXA_LIB_ROOT}/conda/bin"

# --- FROM-extension: a single INFLEXA_LIB_ROOT plus per-installer target env so
# a downstream image's default `pip install` / `install.packages()` / `npm
# install -g` lands inside the store and resolves at runtime with no path
# knowledge. conda/mamba already take `-p $INFLEXA_LIB_ROOT/conda`.
ENV INFLEXA_LIB_ROOT="${INFLEXA_LIB_ROOT}"
ENV PIP_TARGET="${INFLEXA_LIB_ROOT}/python/site-packages"
ENV R_LIBS_USER="${INFLEXA_LIB_ROOT}/r/github"
ENV NPM_CONFIG_PREFIX="${INFLEXA_LIB_ROOT}/node"

# The store is world-readable so the unprivileged sandbox user can read it, matching
# the managed read-only mount's permissions.
RUN chmod -R a+rX ${INFLEXA_LIB_ROOT}

USER sandbox
WORKDIR /workspace

CMD ["sandbox-server"]
