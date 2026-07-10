## Why

The provenance graph already contains everything needed to answer *"where did this file come from?"* — the per-file generation edges, the command-scoped and step-level `used` edges, and the shared `(path, hash)` entity space that merges cross-run chains — but nothing exposes it: `prov` has only `export`, `verify`, and `verify-file`. This is the single question the provenance substrate exists to answer, and the one we cannot currently demonstrate (GitHub issue #66; the open-source positioning makes it a headline claim).

## What Changes

- A new `inflexa prov lineage <analysis> <file>` command: backward lineage by default (what produced this, transitively), `--forward` for what was derived from it, `--depth <n>` to bound the walk, `--format tree|json` (default `tree`).
- A pure traversal layer over the deserialized `ProvDocument` — no schema change, no new storage, and **no new dependencies**. The `dot` format from the issue's sketch is deliberately descoped (per the requester): `tree` serves humans, `json` serves scripting, and DOT can be added later as a pure formatter if ever wanted.
- File references resolve in the shared `(path, hash)` entity space: an exact analysis-scoped path, an exact content hash, or an unambiguous hash prefix. A path carried by several entities (same path, different hashes across runs) walks ALL of them, surfaced per-entity — the same path across runs is a different entity, which is correct and shown, not hidden.

## Capabilities

### New Capabilities

- `prov-lineage`: resolving a file reference to PROV file entities and walking generation/usage edges backward or forward, with tree and JSON renderings.

### Modified Capabilities

- `cli-core`: the `prov` command group gains the `lineage` subcommand.

## Impact

- `cli/src/modules/prov/lineage.ts` (new) — resolution, traversal, formatting, and the command action.
- `cli/src/cli/index.ts` — one lazy-imported subcommand registration.
- No changes to the recorder, builders, events, or storage; the walk reads the same stored bytes `export` serializes.
- Known recording gaps the issue lists (`read_file` reads invisible to lineage, `recordFileToolWrite` uncalled, per-input `wasDerivedFrom` edges) are harness-side and deliberately out of scope; the design documents them as walk-visible limitations.
