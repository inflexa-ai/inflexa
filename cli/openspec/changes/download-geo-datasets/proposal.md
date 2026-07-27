## Why

Users routinely want to analyze a published GEO dataset ("pull GSE12345 and profile it"), but there is no way to get one onto their machine from inflexa. The harness's `search_geo_datasets` finds and cites accessions and then explicitly forbids fetching them, because the sandbox has zero egress — no in-sandbox package (GEOparse, `Bio.Entrez`, wget) can reach NCBI. The download must happen host-side.

Getting the files onto disk is the entire missing piece. Turning local files into analysis inputs is already solved and already reachable three ways — `manage_inputs` in chat, the palette's `AddInputDialog`, and `inflexa inputs add` at the terminal — all of them taking local file paths, and all of them staging and profiling what they enroll. A downloaded GEO Series is just local file paths, so the command downloads and stops there; the user asks for the files to be added when they want them.

## What Changes

- **New `inflexa` command that downloads a GEO Series into the analysis's folder.** Given a Series accession (`GSE…`), it resolves the NCBI file set — SOFT family file, series matrix (per-platform parts when present), author-deposited supplementary files — by enumerating the Series' published directories, and fetches them host-side over HTTPS into `<anchor>/<accession>/`. Raw SRA reads are out of scope.
- **The command does not touch the analysis.** No input rows, no provenance, no staging, no profiling, no harness runtime. It therefore never claims the analysis instance lock and is safe to run as a subprocess beside a live TUI. This is the change's central simplification: an earlier revision enrolled the files automatically, which meant mutating a locked analysis's signed provenance from a second process and needing an out-of-band channel to tell the host about it. Enrolment stays a separate, explicit user action through the path that already exists.
- **The command is classified `approval`** (it writes files) per `agent-command-policy`, and is therefore reachable by the conversation agent through the existing `run_inflexa` tool (`agent-cli-tool`) with an in-chat approval prompt. No new agent tool and no TUI dialog.
- **`run_inflexa` injects the session's analysis into the subprocess** (`INFLEXA_ANALYSIS`), and **`resolveContext` honors it** as an ambient tier between an explicit `--analysis` flag and the working-directory marker. This is what makes a bare chat request — "download geo dataset GSE12345" — land in the chat analysis's folder rather than the subprocess's arbitrary cwd, and it benefits every analysis-scoped command the agent runs.
- **Directory enumeration resolves links rather than matching them.** Each href is resolved against the directory URL and kept only when same-origin and exactly one segment deeper, so navigation links, NCBI's site-wide off-origin footer link, the "Access forbidden" page's `mailto:` links, and path traversal are all excluded by construction. Requests retry with backoff, because NCBI sheds load by answering 403 — indistinguishable from the 403 it serves for a directory with no index.
- **Transfers stage and activate on full success**, so a failed or interrupted download leaves nothing in the user's data folder; a HEAD sweep gives a size estimate and enforces a cap before any bytes move.
- **A shared streaming-download utility** (`src/lib/download.ts`) is factored out of the reference installer's machinery — HTTPS re-checked on redirect, sha256, `.part`→atomic activation, size probe. Repointing `refs/store.ts` at it is tracked separately.

## Capabilities

### New Capabilities

- `geo-input-download`: An `inflexa` command that resolves a GEO Series accession to its processed + supplementary artifact set and fetches it host-side over HTTPS into the target analysis's folder, mutating no analysis state. Classified `approval`; agent-reachable through `run_inflexa`.

### Modified Capabilities

- `agent-cli-tool`: `run_inflexa` gains a requirement to inject the session's analysis id into the spawned subprocess environment (`INFLEXA_ANALYSIS`) when the session is analysis-scoped, sourced from the session scope (never the model argv), via the environment rather than argv rewriting.
- `context-resolution`: `resolveContext`'s precedence gains an ambient tier — explicit `--analysis`/`--project` flag → `INFLEXA_ANALYSIS` (read at the CLI boundary, so the resolver stays library-pure) → `.inflexa` marker walk-up → empty — so an agent-run command targets the chat's analysis regardless of the subprocess's working directory.

(`analysis-service`, `input-staging`, and `agent-command-policy` are consumed unchanged — in fact `input-staging` is not consumed by this command at all. Registering one more approval command is an instance of the existing policy rule, not a change to it; the policy snapshot test is updated as an implementation detail. The harness is not touched.)

## Impact

- **New CLI code**: a GEO source module — accession → NCBI URL resolution, autoindex enumeration, staged HTTPS fetch — plus one registered command action (`registerAction(..., "approval", ...)`). Fetching is a `Result`-returning boundary per the CLI's neverthrow rule.
- **Reused / factored machinery**: a shared streaming transfer utility in `src/lib/download.ts`.
- **Not touched**: input enrollment, staging, seeding, profiling, provenance, the analysis lock, the sandbox, and the harness. The command's whole effect is files on disk.
- **Agent reachability**: automatic once the command is registered `approval` — `run_inflexa` classifies it via the commander parse and prompts before running. The command's help text must fully describe its argument(s) per `cli-reference-docs`.
- **Sandbox library store**: no change needed — once the user adds them, the files are read with the general data tools already provisioned (pandas, numpy, scanpy, anndata; data.table, readr). No GEO-specific parsing library is required.
- **Docs / prose**: the harness `search_geo_datasets` caveat tells the agent that fetching is impossible, which is now misleading — a harness-side edit, tracked separately, not part of this CLI change.
