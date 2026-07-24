## Why

Users routinely want to analyze a published GEO dataset ("pull GSE12345 and profile it"), but there is no way to get one into an analysis. The harness's `search_geo_datasets` finds and cites accessions and then explicitly forbids fetching them, because the sandbox has zero egress — no in-sandbox package (GEOparse, `Bio.Entrez`, wget) can reach NCBI. The download must happen host-side.

Adding an input is already a solved, CLI-owned operation: `applyInputsDiff` / `addInputs` enroll local files, `input-staging` materializes them under `data/inputs`, and the harness bridge seeds and re-profiles. What is missing is only a **new input source** — one that produces the GEO files locally and hands their paths to that existing path. A GEO Series thereby becomes an ordinary analysis input, and a run (which snapshots its inputs at start) profiles and reads it like any other file, with no change to staging, provenance, or the sandbox.

## What Changes

- **New `inflexa` command that downloads a GEO Series and enrolls it as analysis inputs.** Given a Series accession (`GSE…`), it resolves the deterministic NCBI file set — SOFT family file, series matrix (per-platform parts when present), author-deposited supplementary files — fetches them host-side over HTTPS to local disk, and adds them to the target analysis through the existing add-inputs path (`applyInputsDiff` → `input-staging` → seed → re-profile). Raw SRA reads are out of scope.
- **The command is classified `approval`** (it writes) per `agent-command-policy`, and is therefore reachable by the conversation agent through the existing `run_inflexa` tool (`agent-cli-tool`) with an in-chat approval prompt. No new agent tool and no TUI dialog.
- **`run_inflexa` injects the session's analysis into the subprocess** (`INFLEXA_ANALYSIS`), and **`resolveContext` honors it** as an ambient tier between an explicit `--analysis` flag and the working-directory marker. This is what makes a bare chat request — "download geo dataset GSE12345" — target the chat's analysis with no ref, and it benefits every analysis-scoped command the agent runs, not just this one.
- **Reuse the existing streaming-download machinery** in `cli/src/modules/refs/store.ts` (`downloadArtifact`, `measureReferenceDownload`) — HTTPS re-checked on redirect, sha256, `.part`→atomic activate, size probe — factored into a shared utility the reference installer and this command both use.
- **The sandbox parses the added files offline**, with no network — `GEOparse.get_GEO(filepath=…)` / `GEOquery::getGEO(filename=…)`. Parsing is ordinary in-sandbox analysis.

## Capabilities

### New Capabilities
- `geo-input-download`: An `inflexa` command that resolves a GEO Series accession to its processed + supplementary artifact set, fetches it host-side over HTTPS to local disk, and enrolls the files as inputs of a target analysis via the existing add-inputs path. Classified `approval`; agent-reachable through `run_inflexa`.

### Modified Capabilities
- `agent-cli-tool`: `run_inflexa` gains a requirement to inject the session's analysis id into the spawned subprocess environment (`INFLEXA_ANALYSIS`) when the session is analysis-scoped, sourced from the session scope (never the model argv), via the environment rather than argv rewriting.
- `context-resolution`: `resolveContext`'s precedence gains an ambient tier — explicit `--analysis`/`--project` flag → `INFLEXA_ANALYSIS` (read at the CLI boundary, so the resolver stays library-pure) → `.inflexa` marker walk-up → empty — so an agent-run command targets the chat's analysis regardless of the subprocess's working directory.

(`analysis-service`, `input-staging`, and `agent-command-policy` are consumed unchanged. Registering one more approval command is an instance of the existing policy rule, not a change to it — the policy snapshot test is updated as an implementation detail. The harness is not touched.)

## Impact

- **New CLI code**: a GEO source module — accession → NCBI URL resolution, HTTPS fetch to a local temp dir, then `applyInputsDiff`/`addInputs` on the resolved analysis — plus one registered command action (`registerAction(..., "approval", ...)`). Fetching is a `Result`-returning boundary per the CLI's neverthrow rule.
- **Reused / factored machinery**: the streaming transfer primitive in `cli/src/modules/refs/store.ts` factored into a shared utility; input enrollment via `cli/src/modules/analysis/analysis.ts` (`applyInputsDiff`/`addInputs`); staging + seed + re-profile via the existing `input-staging` + `harness-runtime`/`data-profile-launch` paths, unchanged.
- **Agent reachability**: automatic once the command is registered `approval` — `run_inflexa` classifies it via the commander parse and prompts before running. The command's help text must fully describe its argument(s) per `cli-reference-docs`.
- **Provenance**: unchanged. Enrolled files flow through `addInputs` (which emits `prov.input_added`) and stage identically to any other input; a run classifies them as ordinary `data` inputs.
- **Sandbox library store**: confirm GEOparse and/or GEOquery are provisioned so the offline parse path is available (harness/lib-store concern; tracked here as a readiness check).
- **Docs / prose**: the harness `search_geo_datasets` caveat could later point at this command (a harness-side edit, tracked separately, not part of this CLI change).
