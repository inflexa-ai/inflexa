## Why

The cli and the harness are two finished engines with zero wire between them: no cli
code path can run an analysis, and the harness's embedder API (`assembleCoreRuntime`,
the workflow deps bundles, the DBOS launch sequence) has never had a caller — it is
designed but unexercised. This change builds the walking skeleton: the cli embeds
`@inflexa-ai/harness` and triggers a real data-profile run on inputs it staged itself,
converting the embedding seam from "designed" to "proven" and unblocking the provenance
bridge that follows (`docs/harness_integration-new/06-change-graph.md`, change C of the
change graph; the bridge is change D).

## What Changes

- **Input staging**: relocate the untracked `src/modules/staging/` draft into
  `cli/src/modules/staging/` with its two known fixes (symlink entries silently dropped
  by `walkFiles`; `deriveFileId` subpath semantics documented), plus session-tree path
  helpers (`sessionTreeRoot`, staging target dir) ported from the `feat/provenance`
  stash blueprint.
- **Harness embedding**: `cli/package.json` gains `"@inflexa-ai/harness":
  "file:../harness"`; a new composition module realizes the harness's
  `DataProfileDeps` locally (Postgres `Pool` from the infra module's provisioned
  container, Docker sandbox client, proxy-backed chat provider, always-allow run
  authorizer, no-op billing, skills dir at the repo root) and launches DBOS in the cli
  process.
- **Harness barrel growth** (one small harness-side edit riding along): export the
  embedder-facing `StagedInput` type and the data-profile trigger, which the barrel
  omits today.
- **Data-profile launch action**: a new deliberate cli action that stages the
  analysis's inputs into the session tree and triggers the data-profile workflow.
  Deliberate only — staging writes files, so it must never run from a passive flow
  (no-litter policy).

Out of scope, by the change graph: the provenance bridge (bus adapter, run-lifecycle
events — change D), the prov event/builder port (change B), executeAnalysis wiring,
and harness-side deletion of the custom provenance persistence (change E).

## Capabilities

### New Capabilities

- `input-staging`: materialize an analysis's selected inputs into the session tree
  layout the harness expects (`{sessionTreeRoot}/data/inputs/...`), hardlink-first with
  copy fallback, directories walked into per-file entries, producing the
  `StagedInput[]` manifest the harness consumes verbatim.
- `harness-runtime`: the embedding seam — package dependency, DBOS launch against the
  provisioned Postgres, and the local realizations of every `DataProfileDeps` seam.
- `data-profile-launch`: the deliberate user action that stages inputs, triggers the
  harness data-profile workflow, and surfaces its outcome.

### Modified Capabilities

<!-- none: postgres-provisioning already specifies backing the embedded harness and its
requirements are unchanged (this change consumes it); write-boundary is unchanged —
staging writes land inside the sole writable root (the analysis output directory). -->

## Impact

- **cli**: `package.json` + lockfile (new dependency); new `src/modules/staging/`;
  new composition/runtime module; command surface gains the launch action; the cli
  process now hosts a DBOS runtime and connects to the provisioned Postgres.
- **harness**: `src/index.ts` barrel (additive exports) plus one additive helper,
  `sandbox/deliver-exec-event.ts` — the embedder cannot call `DBOS.send` through its
  own SDK copy (module-singleton state; a second `node_modules` copy is un-launched),
  so callback delivery must route through the harness. No existing behavior changes.
- **root `src/`**: the untracked `src/modules/staging/` draft is absorbed (moved into
  `cli/`), shrinking the pre-monorepo leftovers to the one dead TUI draft.
- **Docker**: data-profile runs require the sandbox image and a running Postgres —
  the action must surface actionable errors when either is missing, reusing the infra
  module's self-healing where it exists.
