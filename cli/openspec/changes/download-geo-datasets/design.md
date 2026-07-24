## Context

Adding an input to an analysis is fully implemented and CLI-owned: `applyInputsDiff` → `addInputs` (`src/modules/analysis/analysis.ts`) enroll local paths and emit `prov.input_added`; `input-staging` materializes them under `data/inputs/local/…` as the `StagedInput[]` manifest; the harness bridge (`src/modules/harness/profile.ts`, `seedProfileLedger` + `triggerDataProfile`) seeds and re-profiles. The command palette's `AddInputDialog` and `inflexa new <paths>` are two front ends onto this one path, both taking **local file paths**.

A GEO download needs none of that rebuilt. It needs only a new **input source**: produce the GEO files on local disk, then hand their paths to the existing add-inputs path. The sandbox has zero egress, so the fetch runs in the CLI host process (which has network), exactly where the reference-data installer already downloads. The downloaded files then behave as ordinary inputs — a run snapshots its input set at start, profiles and reads these files like any other, and provenance classifies them as `data`. Nothing in staging, the sandbox, or the harness changes.

## Goals / Non-Goals

**Goals:**
- One command that turns a GEO Series accession into analysis inputs, reusing the existing add-inputs path end to end.
- Host-side fetch (CLI process); offline parse in the sandbox on the added files.
- Agent-reachable through `run_inflexa` with an approval prompt, per the CLI's command policy.
- Reuse the existing streaming-download machinery rather than growing a second one.

**Non-Goals:**
- A new harness tool or capability, or any harness change — input materialization is and stays the CLI's job.
- A new "add input" capability — `applyInputsDiff`/`addInputs` already is it.
- A command-palette dialog — this change is a text command (+ agent reachability), not TUI work.
- Raw SRA sequencing reads (FASTQ) — GB–TB scale, separate egress path and pipeline.
- GSM / GDS / GPL single-sample, curated-dataset, and platform accessions — GSE Series is the unit.
- Cross-invocation, accession-keyed caching / dedup — a later optimization (accessions are immutable).

## Decisions

### D1 — A new input source feeding the existing add-inputs path
The command resolves and fetches the GEO files to a local temp dir, then calls `applyInputsDiff`/`addInputs` with those paths — the same entry point the file picker uses. *Alternative — a bespoke GEO staging path:* rejected — it would duplicate `input-staging` + seed + re-profile, the exact over-build this design exists to avoid.

### D2 — Download processed + supplementary, not raw reads
Fetch the SOFT family file, the series matrix (per-platform parts when present), and author-deposited supplementary files. *Alternatives:* include raw SRA (rejected v1 — separate egress path, sra-tools, pipeline, size); metadata only (too thin — structure without values).

### D3 — Fetch in the CLI host process; parse offline in the sandbox
The command constructs GEO's deterministic public NCBI URLs and fetches host-side, where the reference installer already downloads. The edge-case-heavy parsing happens in the sandbox via `GEOparse.get_GEO(filepath=…)` / `GEOquery::getGEO(filename=…)`, the one path in those packages that needs no network.

### D4 — Classified `approval`; agent reaches it via run_inflexa
The command writes (fetches bytes, enrolls inputs), so per `agent-command-policy` it is `approval` — never `auto`. The conversation agent invokes it through the existing `run_inflexa` subprocess tool (`agent-cli-tool`), which classifies it by the commander parse and shows the in-chat approval prompt. No new agent tool. (Per the CLI convention that a write is a subcommand with its own policy, the GEO source is its own subcommand, not a flag on an existing one.)

### D5 — run_inflexa injects the session analysis; resolveContext honors it
For "download geo dataset GSE12345" to target the chat's analysis with no ref, the ambient analysis must reach the subprocess. `run_inflexa` spawns with the parent env inherited and passes no analysis context today; its `execute(input, ctx)` already holds `ctx.session`. So `run_inflexa` reads the session's analysis id (when scope is analysis-kind) and sets `INFLEXA_ANALYSIS` on the child env, and `resolveContext` gains an ambient tier honoring it (below an explicit flag, above the marker walk-up). *Alternative — inject `--analysis <id>` into argv:* rejected — it breaks the commander parse for commands that do not accept `--analysis` (`--help`, `refs list`), and it would clutter the approval prompt with a machine id; env injection touches neither the parse nor the displayed command. *Alternative — the geo command alone defaults to the current analysis from cwd:* rejected as the robust path — it only fixes geo, and cwd is not guaranteed to match the chat's analysis; injecting the session analysis fixes every agent-run analysis-scoped command at once. The id is read from the trusted session, never the model argv, so wording cannot retarget another analysis. To keep `context-resolution` library-pure, the `INFLEXA_ANALYSIS` value is read at the CLI boundary (via `lib/env`) and passed into `resolveContext` as the ambient ref, not read inside it.

### D6 — Reuse and factor the reference downloader
The streaming transfer primitive in `src/modules/refs/store.ts` (`downloadArtifact`: HTTPS re-checked on the post-redirect URL, sha256, `.part`→atomic activation, progress; `measureReferenceDownload`: HEAD size probe) is factored into a shared utility the reference installer and this command both use, rather than a second downloader.

## Risks / Trade-offs

- **Adding inputs never disturbs a run** — a run snapshots its input set at start, so enrolling GEO files affects only future runs. This is inherent to the existing add-inputs semantics; the command does nothing special to get it. The read-only bind mount does expose new files on disk to an in-flight sandbox, but runs are manifest/plan-scoped and read only what they were told, so nothing is touched. No change needed.
- **Large downloads** — the command reports a size estimate (via the reference downloader's HEAD probe) before fetching and honors a size cap; the `approval` prompt is the user's gate.
- **Supplementary enumeration is fragile** (autoindex format, missing `suppl/`) → treat an empty/absent `suppl/` as a normal "nothing to add", never an error.
- **GEOparse/GEOquery not provisioned** → confirm they are available in the sandbox library store; else the offline parse fails at analysis time with a clear "package not available".
- **Partial fetch then enroll** — fetch all files to a temp dir and enroll only on full success, so a failed download never enrolls a partial input set.

## Migration Plan

Additive — no breaking changes, no harness change. Order: (1) factor the shared transfer utility from `store.ts`; (2) add the GEO source module (accession→URL resolution, fetch to temp, enroll via `applyInputsDiff`); (3) register the `approval` command with full help text; (4) confirm GEOparse/GEOquery provisioning; (5) update the `agent-command-policy` snapshot test for the new command. Rollback is unregistering the command.

## Open Questions

- **Command surface**: exact registry placement / name of the new subcommand (e.g. an input-source subcommand under the analysis input surface) and how the target analysis is referenced (`--analysis <ref>` vs positional), following existing command conventions.
- **Where the factored transfer utility lands** within `src/modules/` (a shared lib vs. staying in `refs/` and imported).
- **Supplementary strategy**: enumerate `suppl/` and fetch selectively, vs. the coarser bundled `?acc=…&format=file` RAW.tar.
- **Multi-platform matrices**: fetch all parts, or expose a selector.
- **Size-cap default** and over-cap behavior (hard fail vs. proceed after the approval prompt).
- **Re-profile eagerness**: rely on the existing add-inputs re-profile trigger as-is, or force an immediate profile.
