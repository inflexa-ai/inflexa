# The store-pipeline postmortem — the three failed runs

Three runs failed on three different single causes, each one layer deeper
in the pipeline. This record gives the mechanism of each cause, the reason
the broken design existed, the fix, and the local proof of the fix. The
run identifiers are 32986283873 (A, 2026-08-26), 33055529460 (B), and
33061094684 (C, both 2026-08-27).

## The short verdict

The build core is healthy, and it was healthy from run B onward. Run C downloaded
539 binaries on EACH arch with zero download failures, built 309
packages with zero build failures, and installed 1104 packages in about
65 minutes. The identical counts across the two arches show a
deterministic pipeline, not a flaky one. Every
red outcome after that came from the checking machinery around the build,
not from the build. Each layer of that machinery ran for the first time
in these runs, and each first run found its own fault.

## Root cause A — the frozen pin, and the redirect it hid

The entrypoint resolved each permitted host one time, pinned the
addresses into `/etc/hosts`, and froze them for the whole run. Two facts
broke that model. p3m.dev publishes a 60-second TTL over a rotating EC2
pool, and AWS documents that a stale answer connects to inactive
addresses. And a binary GET on an edge-cache miss answers 307 to
`rspm-sync.rstudio.com`, a host that no allowlist named.

The old wall dropped a blocked connect in silence. The log shows the
cost: six failures every five minutes for 3.5 hours, which is six pak
workers, each one against a 300-second timeout. 264 CRAN packages died
that way on each arch, and the 240-minute budget killed the job.

Why the design existed: the pin was decision 31 of `decisions.md`. It
solved a real fault, the GitHub rotation under a short TTL, and it passed
review. The model "one frozen address set keeps the rules and the
connects in agreement" is correct for the rules. It is inverted for the
addresses themselves, because a TTL-60 pool decays under the freeze.

Why the probe missed the redirect: a HEAD answers 200 with no redirect,
and a cache-hit GET answers 200 as well. Only a cold-cache GET redirects.
The first probe read a HEAD and a warm GET, thus it reported a clean
route that the cold CI cache never saw.

The fix (`images/sandbox-provisioner/egress-allowlist.sh`): the wall
follows DNS live. dnsmasq feeds the addresses of each answer into an nft
set before the answer returns, and the rules match the set. nftables
replaces ipset, because the ip_set module is not loadable from a
container. The last rule is REJECT, thus a blocked connect fails in
milliseconds and names its host. Both allowlists carry
`rspm-sync.rstudio.com`, and the CLI acquire list gains `p3m.dev`, which
it also lacked. A fatal canary sources the same library, fetches one
binary through the redirect, and proves the closed side, before the
build. Run C proved the whole layer: canary green on both arches, 539
binaries, zero download failures.

## Root cause B — a mountpoint inside a read-only mount

The load-check step bound the farm at `/mnt/libs/farm` inside the
read-only store mount. That mountpoint does not exist in the volume, and
runc cannot make a directory on a read-only filesystem, thus the
container never started. The tolerated exit (`|| true`) then fed an empty
report to the verdict step, which died on the empty JSON.

Why the design existed: the nested bind mirrors the production sandbox
shape, and production runs podman. crun makes such mountpoints, and runc
does not, thus the shape never failed locally. The step itself had never
run in CI, because runs A and B died earlier.

The fix (`package-store-build.yml:305`): the check reads the lock at
`farms/<name>` through the store mount, with no nested bind. The check
derives the farm from the lock argument, and the farm links are absolute
`/mnt/libs` targets, thus the load path is identical. The cache check
keeps its nested bind, because the prepare step mints the mountpoint
first through its read-write parent.

## Root cause C — the R loader that silently ran nothing

`check_r` built one `.libPaths` expression that held every store
directory of the catalog, and passed it as one `Rscript -e` argument. R
caps one `-e` expression at 10,000 bytes, and the catalog list is about
40,000. Past the cap, R prints a WARNING on stdout, executes NOTHING,
and exits 0. The check read no verdict lines, ignored the exit code and
stderr, and marked all 1100 R packages with one bare failure text. The
non-empty floor of the verdict step then correctly stopped the run.

Behind that cap sits a second wall, proven locally: with the expression
fixed, one session loaded 776 namespaces and failed the alphabetic tail
wholesale. A session accumulates the DLL of every loaded namespace and
of every dependency. R caps the loaded DLLs at 614 by default, and a
direct-load variant of the same session segfaulted.

Why the design existed: the one-session loader was written for the
acquisition flight, which checks a handful of packages. At that scale it
stays under every limit, and it ran green for weeks. The catalog was the
first caller at 1100 packages. `load-check.py` had zero test coverage,
and no local run of the catalog path existed before run C failed.

The fix (`images/package-store/load-check.py`):

- Everything rides stdin: the first line carries the library paths, and
  each later line one name. stdin has no cap.
- The loads run in sessions of 48 packages, four sessions beside each
  other. A real sandbox loads a few namespaces per analysis, thus the
  small session is also the faithful shape. `R_MAX_NUM_DLLS=1000` backs
  a dependency-heavy batch.
- A loader that reports zero verdicts from a non-empty batch now marks
  each entry "the R loader itself failed", with the loader's own output
  tail. A dead loader can no longer hide behind per-package lines.
- A genuine failure now carries the R condition message, not a bare
  "failed".

## The noise, classified

- "Missing 40 system packages": an advisory. `PKG_SYSREQS=false` stops
  the sysreq install, and pak lists the wants without a check of the
  image. Zero build failures and 1104 installs prove the toolchain
  sufficed. A probe confirmed cmake, git, perl, and jags in the image.
  pandoc is absent, and it is a runtime renderer, not a build want.
- 17 "Failed to add ... to the cache" warnings, all Bioconductor: the
  in-container pak cache is ephemeral, thus the warning costs nothing
  durable. The cause is not diagnosed. Watch, do not chase.
- The python drops: cellrank (an anndata version conflict) and
  itables_for_dash (no dash in the catalog) are REAL faults kept out of
  the advertised inventory — the check working as designed. Three drops
  were false: junk import names from the wheels (`wrapt-stubs`,
  `site-packages`, `nvidia/cusparselt`) and one empty-imports meta
  package (python-levenshtein) that a name guess condemned. The emitter
  now filters a non-identifier name (`emit_deps.py`, with tests). The
  check tests only a valid identifier, treats present-but-empty imports
  as nothing-to-test, and guesses only when the graph node is absent.

## Why I believed each fix was enough, and what that cost

The wall fix was verified against my own replication of the firewall,
with my own host list. Thus the test proved my assumptions, and not the
run. The mount fix was verified as syntax and as a mount shape. I did
not execute the checked path itself. The real store for that execution
was on this machine the whole time.

Each of the three faults was one local execution away from discovery
before dispatch. That is the discipline failure behind the three lost
runs, and it is mine. The correction is structural, not aspirational.
The fixed check ran against the real catalog on this machine, before
this report. The canary proves the wall inside the pipeline itself, and
a dead loader now names itself. The verification numbers are in the
next section.

## The local verification

The fixed load check ran on this machine, inside the sandbox image,
against the real store and the real catalog farm.

- R: 1100 of 1100 namespaces loaded, zero failures, in the batched
  parallel sessions — proven two times. The broken shape failed 324 of
  the same 1100.
- Python: 426 of 428 distributions loaded through the farm
  site-packages, with the identifier filter active. The two remaining
  drops: biom-format records four valid names it never shipped, and the
  emitter now keeps only an on-disk name, thus the fresh CI graph holds
  it. itables ships a dash integration module, the catalog has no dash,
  and that drop is true — a curation item, not a fault.
- The whole check took 9 minutes 23 seconds on this machine. The CI
  builders are faster.
- The provisioner suite is green: 93 tests, with three new ones on the
  import-name rules.

## The remaining first-live steps

The verdict step now has a green input shape, and these steps behind it
have still never run in CI: prepare, the cache check, the coverage
report, the mountpoint removal, the pack, the publish, commit-locks, and
acceptance. The coverage script ran green on the real lock with no
baseline. The removal step tolerates an absent mountpoint and asserts
emptiness, and the pack step is a read-only walk. The publish and
acceptance touch GHCR and cannot run before a dispatch.

A fourth fault in one of these is possible. Each is small and
file-local, and none has the wholesale shape of the three walls above.

## The next run — the watch points

- Minute ~2 of each store job: the canary line, `code=200` with the
  final rspm-sync URL, then "canary green".
- Minute ~65: the build ends with zero `Failed to download` lines.
- Minute ~70: the load check prints per-package verdicts, and the
  verdict step prints "advertised inventory: N package(s), M dropped"
  with three non-empty R tracks.
- Minute ~75-95: prepare, the cache check, coverage, pack, publish.

The expected whole-run time is 90 to 110 minutes.
