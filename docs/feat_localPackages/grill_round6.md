# Grill round 6 — the audit findings, with context

## C2 — who commits the second phase

The acquire flow, per decision 13: the provisioner installs the set and
stages the graph nodes. The nodes must be computed in-container, because the
edges come from the installed metadata. Then the host boots the sandbox
image and runs the load check. Only after a green check does anything
advertise. The problem: the provisioner container from phase one has exited,
and no subcommand exists for the append.

The two options:

- **(a) A `commit` subcommand.** The flight starts one more provisioner run,
  offline, that appends the staged nodes under the commit mutex. One writer
  owns `deps.json`, at the cost of one container start per batch.
- **(b) The host commits.** The acquire run writes the staged node file as
  pure data. The flight appends it to `deps.json` under the existing
  `lib-store-metadata` lock. Precedent: the download already replaces the
  graph under that same lock (`spike:cli/src/modules/libs/store_download.ts:713-733`).

Recommendation: (b). The staged file is data, the lock exists, and no second
container start is necessary.

## W1 — the link-time both-hit handoff

Decision 15 says: when the pool holds one name in both tracks, a link must
ask, and never silently pick Python. The link resolution is CLI code
(`spike:cli/src/modules/libs/composition.ts:567-618`, Python-first today).
Thus the harness change cannot carry the rule, and the CLI change must. The
finding: no artifact records that handoff. The fix is one line in the
proposal Impact section.

## W2 — the inflexa.lock schema, a draft

The file absorbs `meta.json` (arch, tracks), `packages.txt` (the
inventory), `lock.json` (the run record), and `r-bulk.lock` (embedded).

```json
{
  "schema": 1,
  "arch": "amd64",
  "farm": "catalog",
  "tracks": ["python", "r/cran", "r/bioconductor", "r/github"],
  "packages": [
    {
      "name": "scanpy",
      "version": "1.12.3",
      "track": "python",
      "store_dir": "scanpy-1.12.3-e71bae79",
      "hash": "<full sha256 of the tree>",
      "requested": true
    }
  ],
  "r": { "r_version": "4.6.0", "bioc_releases": ["3.22"], "pak_lock": {} },
  "warm": {
    "scanpy": { "script_sha256": "<sha256>", "cache_entries": ["<entry>"] }
  },
  "collisions": []
}
```

Notes: `requested` separates a direct ask from a transitive dependency.
`hash` is the full tree sha256, and `store_dir` carries the 16-char prefix.
The inventory of `list_available_packages` is the `packages` list.

## W3 — what the coverage guard does

After the load check, the build diffs the loadable set against the last
published artifact of that arch. Three outcomes:

- A package that was published for amd64, is still in the manifest, and now
  fails to load — the build fails. This catches silent upstream breakage.
- A package that the manifest no longer holds — reported as dropped, by
  name, and the build passes. An intentional removal ships.
- An arm64 gap — informational only, because arm64 is best-effort.

The cost is small: the workflow keeps the last inventory per arch and runs
one diff step.

## W4 — the egress host classes per track

The spec names the classes, and the implementation derives the exact hosts
from config:

- `python`: the pinned index host (`INFLEXA_INDEX_URL`, default
  `pypi.org`) and its file host.
- `r/cran`, `r/bioconductor`: the configured pak repositories.
- `r/github` (catalog only): the GitHub hosts, with `GITHUB_PAT`.
- `r/git` (catalog only): `git.bioconductor.org`.

An acquisition run needs only the first two classes. The catalog build needs
all four.

## S1 — the media type strings

The spike values, renamed per decision 14:

- `application/vnd.inflexa.package-store.track.v1.tar+zstd`
- `application/vnd.inflexa.package-store.base.v1.tar+zstd`
- artifact type `application/vnd.inflexa.package-store.manifest.v1+json`

## S2 — the content address, verified in the spike

`tree_hash` (`spike:images/sandbox-provisioner/provision.py:168-192`) is a
sha256 over the sorted tree: each relative path, the file bytes, the
executable bit, and each symlink target. It excludes the two provisioner
markers, uv's `.lock`, `__pycache__`, and the `.pyc`/`.nbi`/`.nbc`
suffixes, because warm-up writes those after the address is taken. The store
directory name carries the first 16 hex characters
(`spike:images/sandbox-provisioner/provision.py:333`). The spec adopts this
contract verbatim.

## S3 — what "names no remedy" means

The harness DOES raise the error, and the error names the missing packages.
The rule only forbids a host command inside the message text. The reason: a
managed deployment holds no `inflexa` binary, thus a message that says "run
inflexa store add" lies there (`bf35f714`). The CLI catches the typed error
and appends its own remedy line, with the exact command.
