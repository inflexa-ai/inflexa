# Prior art: can we reuse an existing tool?

Before we build a package store and a recipe format, we asked whether one already
exists. This document records the answer.

The report uses Simplified Technical English. It marks each claim as **[measured]**
when a command in this session produced it, or **[reported]** when research produced
it from a cited source. Unverified items are listed at the end.

## Verdict

**Build the store. Do not build the recipe format.**

No existing store solves our problem. Three candidates fail on the same point: they
name a package by its build **inputs**, not by its content. Our design needs the
opposite, because two analyses must share one copy of an identical package.

The R problem is different. Good tools exist, and one of them replaces the schema we
were going to write.

## Part 1: the package store

| Tool | Addressing | Why we do not use it |
|-|-|-|
| Guix | Input-addressed | No macOS. Relocation is not real relocation. |
| Spack | Input-addressed | The package set is too old, and the binary cache is empty for our packages. |
| uv cache | Not addressed at all | The key is a random number. |

### Guix

Guix names a store directory from a hash of the build inputs. Its founder stated in
2017 that the content-addressed model "has never been deployed". The 1.5.0 release
notes of January 2026 do not mention it. **[reported]**

Guix writes absolute `/gnu/store` paths into its binaries. It does not use `$ORIGIN`.
`guix pack -R` therefore does not move a package. It creates a false `/gnu/store`
with user namespaces, `ptrace`, or `LD_PRELOAD`. **[reported]**

Guix runs on Linux only. Every developer here uses macOS. **[reported]**

Node coverage is 153 packages, and all are small utilities. **[reported]**

### Spack

Spack names a directory from a SHA-1 hash of the full build graph. Two analyses share
a package only when their whole dependency graphs agree. **[reported]**

The package versions are too old for this product. scanpy is 1.9.1 and anndata is
0.8.0. scvi-tools, cellrank, squidpy and decoupler are absent. Spack has no Node
build system and no Node libraries. **[reported]**

The public binary cache does not hold our packages. It has 2 of 1,189 `r-*` packages,
and 0 of 15 sample bioinformatics packages. We would compile everything. **[reported]**

### uv

uv does not content-address its cache. The key is a 21-character random identifier
from a secure random number generator. The same wheel put into three caches gives
three different keys. The uv source carries this comment: `TODO(charlie): Support
content-addressed persistence via SHAs`. **[reported]**

Therefore uv cannot be the store. It stays the tool that resolves and unpacks. Our
provisioner then moves its output into our store under a real content hash.

## Part 2: R build instructions

Four R packages need more than a name. Two of those needs are now obsolete.

### The ANCOMBC line installs the wrong package

`images/sandbox-python-r/Dockerfile:218` takes ANCOMBC from r-universe. The comment
says r-universe serves the patched 2.12.1.

**[measured] r-universe serves 2.14.0 today. Version 2.12.1 gives HTTP 404, and so
does 2.12.0.** r-universe keeps no archive, and it moves forward with each
Bioconductor release. That line cannot be pinned.

The correct source is the official Bioconductor git mirror. `github.com/bioc/ANCOMBC`
branch `RELEASE_3_22` holds 2.12.1. A commit hash pins it, and both pak and renv
accept that form. **[reported]**

### The frozen Bioconductor URL is safe

**[measured] `https://bioconductor.org/packages/3.22/bioc/src/contrib/PACKAGES`
returns HTTP 200.** It redirects to the Bioconductor archive. The DEP line needs no
change.

### The compiler flag is applied too widely

The build writes `~/.R/Makevars`, installs MSstats and MSstatsTMT, then deletes the
file. Every package that compiles in that period gets the flag. **[measured, from the
Dockerfile]**

MSstatsTMT appears to compile nothing, so the flag does nothing for it. **[reported,
and not confirmed]**

### Which R tool to use

| Tool | Alternative repository | Frozen snapshot | Compiler flag | Lock file |
|-|-|-|-|-|
| pak reference | No | No | No | — |
| **pak lock file** | **Yes** | **Yes** | Partly | **Yes** |
| **renv 1.2.3** | **Yes** | **Yes** | No | **Yes** |
| pkgr | Yes | Yes | **Yes** | No |
| P3M snapshots | Yes | Yes | No | No |

pak cannot express "this package from that repository" in its reference syntax. That
request is r-lib/pak issue 362, open since 2022. Its **lock file** can, through a
`sources` list and `install_args` for each package. A hand-edited lock file installed
the pinned version correctly. **[reported]**

renv 1.2.3 records a `Repository` URL for each package. `restore(strict = TRUE)`
installs from it. **[reported]**

pkgr is the only tool that expresses the compiler flag directly. It has no GitHub
source, so it cannot install our 15 GitHub packages. **[reported]**

No tool solves the compiler flag cleanly. `R CMD INSTALL` has no option for a C++
standard. `--configure-vars` does nothing for a package with no `configure` script.
Only the `R_MAKEVARS_USER` environment variable works. **[reported]**

**Use a pak or renv lock file. Do not write a new schema.**

## Part 3: what to take from the alternatives

1. **Mount each package, not the whole store.** `guix shell --container` computes the
   closure and creates one read-only bind mount for each item, at an identical path.
   This removes the relocation problem, because nothing moves. **[reported]**
2. **Decide which farm conflicts are fatal.** Spack separates a fatal conflict (a file
   against a directory) from a tolerable one (two files). Our farm builder keeps the
   first file and writes a log line. That must become a decision. **[reported]**
3. **Test the farm at start.** With uv symbolic links and no store, a package
   directory keeps its dangling links. Python then reads it as a namespace package.
   The import succeeds and `__file__` is `None`, so the failure appears much later.
   **[reported]**

## Checked and dismissed

Spack rewrites a long program path, because a shebang line has a 127-byte limit on
Linux. We do not have this problem. **[measured] uv writes `#!/usr/bin/python3`, which
is 18 characters, and our longest container path is 60 characters.**

## Not verified

- **Nix.** It is the strongest remaining candidate, because it supports macOS on
  arm64. Nobody examined it.
- **Pixi**, and whether a conda package can move to a different prefix.
- Whether MSstatsTMT truly compiles nothing.
- Whether ANCOMBC 2.12.1 builds against the current CVXR.
