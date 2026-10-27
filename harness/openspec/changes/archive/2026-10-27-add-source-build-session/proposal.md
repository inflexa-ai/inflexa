# Proposal

## Why

The pool serves an analysis from three indexes alone: CRAN, Bioconductor, and the pinned Python index. A package that no index serves — SeedMatchR 2.0.0, which CRAN archived and which lives only as a fork on GitHub at a pinned commit, or a package that exists only as a folder on the local disk — cannot reach a farm. The query grammar refuses a location, thus `store add` cannot even name it (#746). The user installs such a package by hand, and the sandbox cannot load it.

Each source repository carries its own build steps, thus a fixed program cannot install them all. An LLM can read the repository, make a build plan, and run the build inside the provisioner, where the compilers and the network live.

## What Changes

- A new conversation-agent tool, `install_from_source`. It takes a git URL with an optional ref, or a local folder. It is on the roster only when the embedder binds a new `BuildSession` interface — the same pattern as `link_packages` and `ExtendAnalysisFarm`.
- The tool runs on the chat path, thus `ctx.ask` is available, and its input is one of four operations: `start`, `exec`, `commit`, `stop`, keyed by a session id. The session explores first — a container whose egress holds the git host alone, with the source cloned at the resolved commit — and the agent reads the repository before any plan. One ask then shows the plan: the source, the full commit sha, the host list, the apt packages, and the build strategy. One ask covers each command, with a session-scoped `always`. One ask precedes the commit, and it shows the build script and the build record.
- A build session is a held provisioner-image container with no store mount, a scratch volume for the source and the build, and a session egress allowlist that the plan names and the user approves. The host keeps a pristine snapshot of the source; the session works on its own copy, and the clean run reads the pristine snapshot alone.
- The build is a hybrid. The LLM works in the session until the build succeeds. It writes the commands that worked into one build script. One clean run of that script, in a new provisioner container, produces the stored artifact.
- A new provisioner subcommand, `acquire-source`, runs the clean run. It takes the pristine source snapshot and the build script, and the script builds exactly one root artifact into a named output directory — the dependencies install through the current hash-pinned paths. The run writes the artifact into the pool as a normal store directory, stages the graph nodes, and writes a build record.
- The pin of a source-built package carries a source qualifier, for example `SeedMatchR==2.0.0@git:2fc0c4f`. `find_stored` matches the full pin, thus an index acquire never matches a source build, and a source build never matches an index acquire.
- A source-built R package links under a new `r/source` farm subtree. The farm lock entry of a source-built package carries a `source` field. The lock schema stays at 1, because the shape accepts additive fields.
- The commit enforces the link rule: each `.so` of the artifact links statically, or links only to libraries that sandbox-base has. The check runs `ldd` inside the sandbox image, and a `not found` line fails the commit with the library named.
- The provisioner image gains `autoconf`, `automake`, `libtool`, `meson`, `ninja-build`, and `patchelf`. The image keeps no apt lists. The session runs `apt-get update` against a dated Ubuntu snapshot.
- `store add` keeps its grammar. The sandbox prompt does not change. The conversation prompt needs no change: it already directs the agent to look for a tool that can provision a package.

## Capabilities

### New Capabilities
- `source-build-session`: the harness `BuildSession` interface, the `install_from_source` conversation tool, and the approval flow of an LLM-driven source build.

### Modified Capabilities
- `package-store-provisioner`: the subcommand set gains `acquire-source`. The acquisition hash rule gains an exception for the source-built package only; its dependencies keep the hash rule. The git refusal of `acquire` stays, because the source path is a different subcommand. The build record and the link rule join the commit contract.
- `package-store`: the farm lock gains the `source` field. The subtree-to-track mapping gains `source`, and `R_LIBS_SITE` covers `r/source`.

## Impact

- `harness/src/sandbox/types.ts` — the new `BuildSession` interface, beside `ExtendAnalysisFarm`.
- `harness/src/tools/` — the new tool module and its tests.
- `harness/src/sandbox/mount-plan.ts` — `R_LIBS_SITE` covers `r/source`.
- `images/sandbox-provisioner/provision.py` — `acquire-source`, the source pin qualifier, the build record.
- `images/sandbox-provisioner/Dockerfile` — the added build tools.
- `images/package-store/load-check.py` — the `ldd` link-rule check of the commit.
- The sibling CLI change `add-source-build-session` (cli tree) realizes the interface: the held container, the exec channel, the session egress class, the clean-run flight, and the farm lock `source` field.
- Out of scope: C and C++ command-line tools (#747) and the AnnotationHub data of SeedMatchR (#698).
