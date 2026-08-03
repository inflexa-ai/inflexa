# From prototype to production

This report answers four questions about the two-container package store:

1. What must we do to make it production ready?
2. What must we test?
3. How do we build and handle R?
4. How do we make sure that it works well?

The report uses Simplified Technical English. All measurements come from tests on
this machine (linux/arm64, podman 5.8.3). The report marks each unverified item.

## 1. Summary

The prototype proves the mechanism. It does not prove the product.

The hard technical risks are now closed. Symbolic links do not break compiled
extensions, vendored shared libraries, or package metadata. R packages relocate
without a problem. The provisioner compiles a package from source. Two analyses
share one copy of a package, and each analysis still keeps its own versions.

Three risks remain, in order of size:

1. **Kubernetes storage.** The managed service mounts a volume claim, not a host
   directory. A shared store needs a claim that many nodes can read. This is a
   storage decision, not a code change.
2. **Supply chain.** The prototype does not pin the hash of a downloaded file.
3. **Operations.** Nothing removes an unused package. Nothing locks the store.

## 2. What the tests prove

| Property | Evidence |
|-|-|
| Compiled C extensions load through links | numpy gives correct results |
| Vendored shared libraries resolve | `scipy.linalg.det` is correct; `$ORIGIN` stays inside one store directory |
| Package metadata resolves | `importlib.metadata` reports correct versions |
| Namespace packages merge | 50 packages, 0 collisions |
| The provisioner compiles from source | `pyahocorasick` built `ahocorasick.cpython-312-aarch64-linux-gnu.so` |
| Packages are shared | A second scanpy analysis added 8 MB to a 769 MB store |
| Analyses stay isolated | The `demo` farm keeps numpy 2.5.1 while `sc` uses numpy 2.4.6 |
| The sandbox posture does not change | No network, uid 1000, all capabilities dropped, read-only store |

Disk use: 2.34 GB for the `sandbox-base` image, plus 776 MB for a store of 52
packages. The `sandbox-python` image measures 11.4 GB on this machine. This report
does not measure `sandbox-python-r`.

## 3. R packages

### R is the easiest of the three languages

Tests show that R packages relocate safely:

- The install path does not appear in any installed file. The test searched text
  files and binary files.
- The compiled objects have no `RPATH` and no `RUNPATH`.
- `library()` loads a package through a symbolic link. `Rcpp::evalCpp("1+1")` gives 2.

conda is the opposite. conda binaries contain the build path, so you cannot move
them. Python is between the two.

### Two designs work. Use the farm.

R accepts a list of library paths in `R_LIBS_SITE`, so a farm is not necessary. But
a long list is slower:

| Design | `.libPaths()` entries | 20 `library()` calls |
|-|-|-|
| One path for each package | 205 | 0.70 s |
| One farm path | 3 | 0.36 s |

The manifest holds 168 R packages. Use a farm. It gives one path, better speed, and
the same design as Python.

R also removes a path that does not exist from `.libPaths()`, and it gives no
message. A wrong path therefore fails silently. Check each path.

**The harness needs no change.** `harness/src/sandbox/mount-plan.ts:112` sets
`R_LIBS_SITE` to three directories below `/mnt/libs/current/r/`. Those directories
become the farms.

### The build problem is r2u, not R

On amd64 the build uses r2u. r2u installs CRAN packages as Ubuntu `.deb` files
through apt. apt writes them to a system directory. The build then copies the whole
tree into the store:

- `images/sandbox-python-r/Dockerfile:151` copies `/usr/lib/R/site-library/*`.
- `images/sandbox-python-r/Dockerfile:234` copies the packages that bspm installed.
- `images/lib-store-manifest.yaml:79` explains why the manifest lists transitive
  dependencies: without them, bspm puts packages outside the store.

A store needs one directory for each package. A bulk copy gives one flat tree.

**This is easy to solve.** An R library holds one directory for each package. The
provisioner can split the copied tree. For each subdirectory it reads the name and
the version from the `DESCRIPTION` file, computes the content hash, and moves the
directory into the store. Keep r2u for speed. Add a split step after it.

### Four more R items

1. **R has no closure resolver.** Python has `uv pip compile`. R has no equivalent
   in the base tools. Use `renv`. It writes a lock file with the package, the
   version, the source, and a hash.
2. **Bioconductor couples its release to the R version.** Pin both. A store entry
   must record which Bioconductor release built it.
3. **`LinkingTo` packages need a stable ABI.** A package that compiles against Rcpp
   headers must load the same Rcpp at run time. The lock file must hold both.
4. **arm64 has no r2u.** The source compile is slow and incomplete. The current
   build treats the arm64 R image as best-effort. A store does not change this.

## 4. The managed service is the biggest open item

The Docker backend takes a host path. The Kubernetes backend takes a volume claim
name (`harness/src/sandbox/k8s-client.ts:86`). It mounts the whole claim read-only
at `/mnt/libs` and uses no `subPath` (`k8s-client.ts:218`).

**A second volume is easy.** The pod already carries three volumes. A fourth needs
the same code block.

**The storage is the hard part.** A claim in `ReadWriteOnce` mode binds to one node.
Every sandbox that uses the store would then run on that node. A shared store needs
`ReadOnlyMany` or `ReadWriteMany`. Choose the storage class before the code.

**Kubernetes does not check the store.** The Docker backend calls `libStoreUsable`
before each create (`docker-client.ts:126`). The Kubernetes backend only checks that
the configuration names a claim. Add an equal check, or the pod mounts whatever the
claim holds.

## 5. Work to do before production

### 5.1 Supply chain (do this first)

| Gap | Action |
|-|-|
| The prototype does not pin source hashes | Add `--generate-hashes` to `uv pip compile`. `uv` supports it. The prototype hashes the *installed result*. That finds corruption. It does not stop a substituted upstream file. |
| The package index is not pinned | Pin the index URL. Refuse an unexpected host. |
| The provisioner has full network access | Restrict its egress to the package indexes. |
| Nothing verifies the store later | Re-hash a store directory on demand. Report each directory that changed. |

### 5.2 Concurrent access, failure, and disk

| Gap | Action |
|-|-|
| One `current` pointer selects one farm | Two analyses cannot use different closures together. Give each sandbox its own store path, or add a mount for each step. |
| Two provisioners can run together | Add a lock for each store. The content address makes the package writes safe. The `current` pointer has no protection. |
| Nothing removes an unused package | There is no cleanup for any store in this repository. The reaper removes sandboxes only. Add a command that removes a store directory that no farm uses. |
| A stopped provisioner leaves a `.staging` directory | The next run removes it. Add a repair command. |

Copy the pattern from `cli/src/modules/refs/store.ts`. It is the repository's
precedent for a host installer. It stages into a temporary directory, renames the
directory into place, and writes the receipt after the rename. A crash therefore
reads back as `partial`, and the next install repairs it. Note one limit: that
installer has no lock between processes either.

### 5.3 Integration

| Gap | Action |
|-|-|
| The CLI does not pass `libStorePath` | Pass it at `cli/src/modules/harness/runtime.ts`. The harness already binds it. |
| `list_available_packages` reads a host path | Point the `packagesFile` dependency at `<store>/current/packages.txt`. |
| Nothing seeds the prepared caches | Add the copy step to `images/sandbox-base/sandbox-entrypoint.sh`. It runs before the workload in every transport mode. |
| `PIP_TARGET` points at a read-only directory in `sandbox-python` | Override it for each session. `sandbox-base` does not set it. |
| conda is not covered | Mount the conda prefix whole, at the path that built it. Do not link it. |

### 5.4 Two specs contradict this design

Change both before the code:

1. `harness/openspec/specs/lib-store/spec.md` holds the requirement **"No runtime
   package installation"**. The store makes installation possible through the host.
2. `cli/openspec/specs/lib-store-provisioning/spec.md:99` states that the CLI
   **shall not** create a `/mnt/libs` bind mount, because the image bakes the store.

The two specs already disagree with each other today. The harness spec describes a
bind mount that the CLI never creates. This work is the correct time to settle it.

### 5.5 The agent contract

Three places tell the agent that installation is impossible. All three become
false:

1. The `packages.txt` header.
2. `harness/src/tools/sandbox/list-available-packages.ts:209`.
3. `harness/src/prompts/sandbox-standards.ts:94`.

The sandbox still has no network access. Installation becomes a host action. Decide
who starts it. The repository has a precedent: `inflexa sandbox pull` uses the
`approval` policy, so the user confirms the action.

## 6. Tests to add

| Test | Why |
|-|-|
| amd64 | Every measurement in this report comes from arm64. |
| The R tracks, end to end | This report tests 3 R packages. The manifest has 168. |
| Bioconductor | It has the deepest dependency graph and the most compiled code. |
| conda | The prototype does not test it. |
| A full closure, equal to the current image | Prove that no manifest package fails. |
| Two sandboxes together | The `current` pointer is a shared resource. |
| A stopped provisioner | Stop it during an install. The next run must repair the store. |
| A full disk | The provisioner must fail with a clear message. |
| A wrong hash from the index | The provisioner must refuse the package. |
| Cold start time | Compare the time to a first import against the baked image. |
| A store of 500 packages | Measure the farm build time and the import time. |
| Kubernetes with a shared claim | Prove that many pods read one store. |

## 7. How to make sure that it works well

**Reuse the validation suite that exists.** `scripts/lib-store-validate/validate.py`
already imports every package that `packages.txt` advertises. Its rule is that
`packages.txt` must not lie. `scripts/lib-store-acceptance.sh` already has a
`--store <dir>` mode that mounts a store into `sandbox-base`. That mode is close to
what this design needs. Point it at a farm.

**Make the tests gate the change.** The image build runs on manual dispatch only,
and the acceptance workflow is non-gating. A store that a user can change at run
time needs a stricter rule than an image that a person publishes by hand.

**Add the prototype suite to CI.** `acceptance.py` holds 15 checks. Run it on both
architectures for each change to the store code.

**Compare against the baked image.** Build the same package set two ways. The
versions and the import results must agree. This finds a fault that a
self-consistent test cannot find.

**Fail closed.** `libStoreUsable` already refuses an incomplete store. Keep that
rule, and add the equal check to Kubernetes.

**Measure the cache.** A prepared cache is easy to lose. Count the cache loads and
the cache saves. A save at run time means that the preparation failed.

**Record the closure with the analysis.** Write the lock file into the provenance
record. A reader can then rebuild the same environment.

## 8. Suggested order of work

| Phase | Content | Result |
|-|-|-|
| 1 | Specs; hash pinning; index pinning; store verify | The design is agreed and the supply chain is safe |
| 2 | Python track in the CLI; cache seeding in the entrypoint | One real analysis runs from a store |
| 3 | R track, with the r2u split step | The main image becomes replaceable |
| 4 | conda prefix mount | Parity with the current image |
| 5 | Farm for each sandbox; locks; disk cleanup | More than one analysis together |
| 6 | Kubernetes claim and a shared storage class | The managed service can use it |
| 7 | The agent tool and the approval flow | A user can add a package |

Phase 1 and phase 2 give a testable product. Phase 5 and phase 6 are necessary for
the managed service, because it runs many analyses together.

## 9. Clarifications

### 9.1 R packages that need hand-written build code

This is correct. Four cases exist today, and the manifest cannot express any of
them. The manifest holds only names, so the exceptions live as shell code in
`images/sandbox-python-r/Dockerfile`:

| Package | Special action | Line |
|-|-|-|
| ANCOMBC | Install from the r-universe mirror. Bioconductor 3.22 gives 2.12.0, which calls a function that CVXR 1.8 removed. | `:218` |
| DEP | Install from the frozen Bioconductor 3.22 repository. Bioconductor 3.23 dropped the package. | `:222` |
| MSstats, MSstatsTMT | Write `~/.R/Makevars` with `CXX11STD = -std=gnu++14`, then remove it. RcppArmadillo 14.2 needs the override. | `:226` |
| 15 GitHub repositories | `remotes::install_github`, with a GitHub token and a retry loop. | `:263` |

**The work ports well, and it improves.** Each case answers the same question: from
where do we get this package, and how do we build it? That question belongs to the
provisioner. The provisioner is the one component with the compiler and the network.

Make each exception a **recipe** — data, not shell code. A recipe holds the source,
the version, and the build flags. Put the recipe beside the package name in the
manifest.

Two gains follow:

1. The `Makevars` override is global today. The build writes the file, installs two
   packages, and removes the file. A recipe makes the flag local to one package.
2. A recipe records **why**. The store then holds the reason with the package.

One risk: if the recipes stay as shell code, the store inherits the present problem.
The recipes must be data.

### 9.2 Package managers

| Language | Manager | Where |
|-|-|-|
| Python | `uv` 0.7.12 | `images/sandbox-python/Dockerfile:60`, and the prototype |
| R (CRAN, amd64) | r2u, through apt | `images/sandbox-python-r/Dockerfile:64` |
| R (CRAN, source) | `install.packages` | the arm64 path |
| R (Bioconductor) | `BiocManager::install` | `:215` |
| R (GitHub) | `remotes::install_github` | `:287` |
| System tools | micromamba 2.5.0 | `images/sandbox-python/Dockerfile:251` |
| Node | npm | `:320` |

**Python is solved.** `uv pip compile` gives the closure. `uv pip install --no-deps
--target` installs one package into one directory. The prototype uses both.

**R has no single manager, and no lock file.** Four install paths exist. None of them
writes a lock file. Add `renv` for that job. `renv` records the package, the version,
the source, and a hash. Keep the four install paths. `renv` sits above them.

### 9.3 Performance

The design costs nothing measurable. The test used one image, one package set, and
one filesystem, and repeated `import scanpy` five times.

| Layout | Median | Note |
|-|-|-|
| Symlink farm, container filesystem | 1.18 s | the design |
| Real directory, container filesystem | 1.15 s | the control |
| Baked image | 1.39 s | today, scanpy 1.12.2 against the farm's 1.12.3 |
| Symlink farm, macOS bind mount | 2.73 s | a development artifact |

**The symlink farm costs about 3 percent.** That is inside the noise of the test.

The first measurement of this pair was wrong, and the error is worth recording. It
compared the farm on a macOS bind mount against a real directory on the container
filesystem. That showed a penalty of 2.4 times. The penalty came from virtiofs, the
file system that shares a macOS directory into the virtual machine. It did not come
from the symbolic links. On Linux, a bind mount does not use virtiofs.

Two effects follow:

- **Production is not slower.** The managed service and Linux hosts use a bind mount
  or a volume. Neither uses virtiofs.
- **macOS development is slower.** A developer on macOS sees a slower import than
  today, because the baked image reads from the container filesystem. Measure this
  again on Linux before you accept the number.

Container start does not change. The image becomes smaller, so the pull is faster.

### 9.4 How to measure, and the back-of-the-napkin figures

**Method.** Control the filesystem first. It is larger than every other effect. Use
one image, one package set, and five repetitions. Report the median and the minimum.
Compare a farm against a dereferenced copy of the same farm.

**Data.** Use the manifest as the workload. It holds 287 packages, which is the real
size. Build farms of growing size from it, and record the import time, the farm build
time, and the store size at each step.

**Measured figures**, from a store of 52 packages:

| Figure | Value |
|-|-|
| Total store | 776 MB |
| Mean package | 14.9 MB |
| Median package | 1.1 MB |
| 90th percentile | 36.7 MB |
| Largest package | 168 MB (llvmlite) |
| Five largest together | 461 MB, which is 59 percent |

The distribution is very uneven. A few numeric packages hold most of the bytes, and
every analysis shares them. This is why the design works.

**Sharing, measured across three farms:**

| Farm | Packages | Size if stored alone |
|-|-|-|
| demo | 3 | 186 MB |
| sc | 50 | 716 MB |
| sc2 | 51 | 723 MB |
| **Sum** | | **1625 MB** |
| **One shared store** | 52 | **776 MB** |

The store saves 52 percent for three analyses. The saving grows with each analysis.
`sc` and `sc2` share 50 packages, which is 716 MB.

**The calculation.** For N analyses that use one common stack:

```
disk = base image + first closure + (N - 1) x new packages for each analysis
     = 2.34 GB    + 0.72 GB       + (N - 1) x ~0.01 GB
```

The measured marginal cost was 8 MB. Ten scanpy analyses therefore need about
3.1 GB. The baked `sandbox-python` image needs 11.4 GB for the first one, and the
same 11.4 GB whether you run one analysis or ten.

The break-even point is immediate. The store is smaller from the first analysis.

**Measure these four numbers in CI:** the import time, the farm build time, the store
size, and the count of cache loads against cache saves. A cache save at run time
means that the cache preparation failed.

### 9.5 Recipes for the hand-written build code

Yes. Use a declarative recipe. Do not use `make` or `cmake`.

**Why not make.** `make` builds one artifact from sources that you control. Here you
control no source. You need to record where a package comes from, which version to
take, and which flags to apply. `make` gives no provenance and no hash. It would only
move the present shell code to another file.

**The precedent is already in this repository.** `system_tools` comes from bioconda.
A bioconda recipe is a `meta.yaml` file. It holds the source URL, the SHA-256 of the
source, the build script, the patches, and the pinned dependencies. Nix, Spack, and
Homebrew all chose the same shape: declarative data plus a hash.

**Do not adopt conda-build for R.** A conda package is not relocatable, for the same
reason that the store cannot link a conda prefix. It would fight the design.

#### Three parts, not one

This distinction decides whether the result is reproducible:

| Part | Question it answers | Gives you |
|-|-|-|
| **Recipe** | How do we build this package? | Stability |
| **Lock file** | What exactly did we build, last time? | Reproducibility |
| **Content hash** | Is what we got the same as what we locked? | Integrity |

A recipe alone does not make a build reproducible. A recipe says "install ANCOMBC
from r-universe". r-universe can move. The lock file names the version that the last
build used. The content hash proves that the bytes did not change.

The prototype has the third part. It has no recipe and no source lock.

#### A schema that does not break the present build

Every manifest list holds plain strings today. Every build reads them with
`'\n'.join(...)`. Therefore allow each entry to be **either** a string **or** a
single-key map. The parsers normalise both to a name and a set of options. Nothing
that exists must change.

```yaml
r:
    bioconductor:
        - DESeq2                       # unchanged: a plain string

        - ANCOMBC:                     # a recipe
              version: "2.12.1"
              repos: ["https://bioc-release.r-universe.dev"]
              reason: >
                  Bioconductor 3.22 gives 2.12.0. That version calls CVXR::solve,
                  which CVXR 1.8 removed. r-universe serves the patched 2.12.1.

        - DEP:
              repos: ["https://bioconductor.org/packages/3.22/bioc"]
              reason: "Bioconductor 3.23 dropped the package."

        - MSstats:
              makevars: { CXX11STD: "-std=gnu++14" }
              reason: "RcppArmadillo 14.2 and later need the C++14 override."
```

#### What this gains

1. **The build flag becomes local.** Today the build writes `~/.R/Makevars`, installs
   two packages, and removes the file. Every package built in that window gets the
   flag. A recipe applies the flag to one package.
2. **The reason travels with the package.** Today the reason is a comment in a
   Dockerfile. A reader of the store cannot see it.
3. **One reader, three users.** The image build, the provisioner, and the coverage
   report all read the same file. Today only the image build knows the exceptions.
4. **A recipe change is reviewable.** A person can read a diff of the data. A diff of
   escaped shell inside a `RUN` line is much harder to review.
5. **The exception count becomes visible.** Today nobody can count the special cases
   without reading the Dockerfile.

#### The rule that keeps it honest

The recipe must be **data**. If a recipe holds a shell command, the store inherits the
present problem. Give the recipe a fixed set of fields: `version`, `repos`, `source`,
`makevars`, `patches`, `reason`. Add a field only when a real package needs it. Refuse
a free-text command.

## 10. Open decisions

1. **Does the store replace the baked image, or add to it?** A baked image gives a
   fast cold start. A store gives a small download and user installs. The two can
   work together: bake a base set, and put the user's additions in a store.
2. **Which storage class does the managed service use?** This decides whether many
   pods can share one store. Answer it before the Kubernetes work starts.
3. **Can a user choose a version?** If yes, the store needs a rule for a conflict
   between an analysis and the base set.
4. **How long does a store keep a package?** A package that no current farm uses is
   still necessary to repeat an old analysis.
