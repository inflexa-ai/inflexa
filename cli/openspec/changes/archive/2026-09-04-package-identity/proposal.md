# Package identity: the host reads and writes the typed identity

## Why

The cli holds the second copy of the PEP 503 fold
(`composition.ts:675`) and a six-step ladder that only it runs
(`composition.ts:622`). It holds a flight key that folds an R name
(`store_flight.ts:105`). It holds three parsers of the query grammar that
disagree (`store.ts:1005`, `store.ts:920`, `dev/run.ts:417`). Two live
faults come from those sites: a Python flight answers an R miss, and a
replayed plan cannot read a prefix. The companion harness change
`package-identity` exports one module with the types, the parser, and
the ladder. This change makes the cli consume it, and it adds no spec of
its own.

## What Changes

- `resolvePackageRequest` becomes a thin call: it builds a `PoolIndex`
  over the graph, it calls `resolveQuery` of the harness, and it picks the
  version. `canonicalDistributionName`, the local ladder, `rDir`, and the
  unread `error.name` leave `composition.ts`.
- The refusal shapes carry identities. `unknown_distribution` carries the
  suggestion as an identity key. `ambiguous_ecosystem` carries the two
  identity keys beside the two head directories.
- The flight ledger keys the spelling and the track. The flight id is
  `<track or any>::<spelling>::<specifier>`. Migration 10 rebuilds the two
  request tables: `spelling` replaces `name` and `raw_name`.
  **BREAKING** for a development database: a live flight row rebuilds
  from its `raw_name`.
- `classifyPoolMiss` takes a query, and it matches a row by identity when
  both carry a track. A Python flight no longer answers an R miss.
- `store add`, `store link`, and `inflexa run --plan` parse their argument
  with `parseQuery`. A prefix at the command surface refuses with the
  `--lang` remedy, as the command spec requires. `store add scanpy==1.11`
  records the version.
- The acquisition commit resolves a bare edge through `identityOf`, and
  `provisionerSpec` becomes `formatQuery`.
- The pool inventory sections carry their track.
- The graph reader keeps `GRAPH_VERSION` at 2, and it ignores `r_dir`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `farm-composition`: the resolution runs through `resolveQuery` of the
  harness, the identity replaces the canonical name as the lookup key,
  and the reader ignores `r_dir`.
- `package-store-management`: `store add` and `store link` parse a query,
  the ledger keys the spelling and the track, the pool-miss classification
  compares identities, and the launch refusal renders identities.

## Impact

- `src/modules/libs/composition.ts`, `src/modules/libs/store_flight.ts`,
  `src/modules/libs/store.ts`, `src/modules/libs/packages.ts`,
  `src/modules/harness/runtime.ts`, `src/modules/harness/dev/run.ts`.
- `src/db/primary_migrations.ts`, `src/db/primary_query.ts`,
  `src/db/primary_mutation.ts`, `src/types/store.ts`.
- `src/tui/components/failed_flight_dialog.tsx`,
  `src/tui/layout/design_gallery.tsx`, the sidebar gate seam.
- The fixtures under `src/modules/libs/test-fixtures/` drop `r_dir`.
- This change compiles against a harness that exports
  `package-identity`, and it reads graph version 2 as the harness change
  redefines it.
