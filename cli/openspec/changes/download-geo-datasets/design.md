## Context

Users routinely want to analyze a published GEO dataset, but there is no way to get one onto their machine from inflexa. The harness's `search_geo_datasets` finds and cites accessions and then explicitly forbids fetching them, because the sandbox has zero egress. The download must happen host-side, in the CLI process, exactly where the reference-data installer already downloads.

Getting the files onto disk is the whole problem. Everything after that is already built and already reachable: `applyInputsDiff` → `addInputs` enroll local paths and emit `prov.input_added`; `input-staging` materializes them under `data/inputs/local/…`; the harness bridge seeds and re-profiles. The user reaches that path from chat with `manage_inputs`, from the palette with `AddInputDialog`, and from the terminal with `inflexa inputs add` — three front ends onto one path, all taking **local file paths**. A downloaded GEO Series is just local file paths.

## Goals / Non-Goals

**Goals:**

- One command that downloads a GEO Series accession into the analysis's folder, correctly and completely.
- Host-side fetch (CLI process); offline parse in the sandbox on the files once they are inputs.
- Agent-reachable through `run_inflexa` with an approval prompt, per the CLI's command policy.

**Non-Goals:**

- **Enrolling the files as inputs.** Adding an input is a solved, user-driven action with three existing front ends; this command does not duplicate, wrap, or trigger any of them.
- A new harness tool or capability, or any harness change.
- A command-palette dialog — this change is a text command (+ agent reachability), not TUI work.
- Raw SRA sequencing reads (FASTQ) — GB–TB scale, separate egress path and pipeline.
- GSM / GDS / GPL single-sample, curated-dataset, and platform accessions — GSE Series is the unit.
- Cross-invocation, accession-keyed caching / dedup — a later optimization (accessions are immutable).

## Decisions

### D1 — Download only; enrolment stays the user's separate, explicit step

The command writes files and stops. It records no input rows, emits no provenance, stages nothing, profiles nothing, and boots no runtime. The user then asks for the files to be added as inputs through the path that already exists.

*Alternative — enroll the downloaded files automatically (the original design):* rejected. It bought nothing the user cannot already do in one sentence, and it cost a great deal:

- **It broke the analysis lock.** Enrolment emits provenance, and every other mutating surface claims the analysis instance lock first (`inputs add/remove`, `chat`, `profile`, `run`). A subprocess spawned by `run_inflexa` beside a live TUI cannot hold that lock — which is precisely why `inputs add` is classified `blocked` for the agent. An auto-enrolling `geo add` was the same mutation through a door that skipped the guard, and it forked the signed provenance chain: the host's cached document overwrote the child's records and `verifyAnalysisIntegrity` reported `tampered`.
- **It needed a reconcile channel back to the host.** The child emits `prov.input_added` on its own bus, which the host never sees, so the host had to be poked out of band to re-stage and re-profile (the `onReconcile` hook, D-removed below). That hook fired after every successful analysis-scoped action, including read-only ones.
- **It coupled two independent decisions.** "Fetch this dataset" and "make this dataset an input" are separate user intents; a user may reasonably want the files without profiling them.

Dropping enrolment deletes all of it: no lock to claim, no provenance to fork, no reconcile channel, no staging trigger.

### D2 — The files land in the analysis's home folder

A downloaded Series goes to `<anchor>/<accession>/` — the folder the user ran `inflexa` in, beside their other data. Downloaded data is the user's, in the place they already keep data, visible without `inflexa open` and addable by the same paths as anything else there.

*Alternative — the analysis workspace (`.inflexa/analyses/<slug>/geo/`):* rejected — hiding a 150 MB download the user asked for inside a dot-directory makes it hard to find and hard to reason about, and the workspace is inflexa-managed space for staged copies and run artifacts, not a home for source data. *Alternative — a shared `env.geoDir` cache:* rejected for v1 — an accession-keyed cross-analysis cache is a real optimization (accessions are immutable) but it separates the bytes from the analysis they belong to, and nothing yet reference-counts them.

The target folder is resolved through `resolveContext`, so the agent path lands in the chat analysis's folder rather than the subprocess's arbitrary cwd (see D5).

### D3 — Download processed + supplementary, not raw reads

Fetch the SOFT family file, the series matrix (per-platform parts when present), and author-deposited supplementary files — the last is not optional garnish: for most modern RNA-seq Series the count matrices live in `suppl/`. *Alternatives:* include raw SRA (rejected v1 — separate egress path, sra-tools, pipeline, size); metadata only (too thin — structure without values).

### D4 — Enumerate by resolving links, never by pattern-matching hrefs

GEO serves each directory as an Apache autoindex, so the artifact set is discovered by enumeration — a guessed filename cannot find the per-platform matrix parts of a multi-platform Series. But an autoindex is a web page, and a listing scan that filters hrefs by pattern cannot reliably tell a file from the page's furniture: NCBI puts a site-wide `https://www.hhs.gov/vulnerability-disclosure-policy/…` link on **every** page, spells the parent link as an absolute path, and serves an "Access forbidden" page (with `mailto:` links) for any directory lacking an index.

Each href is therefore *resolved against the directory's own URL* and kept only when the result is same-origin and names exactly one further segment. That one test subsumes every case a negative filter kept getting wrong, and disposes of path traversal for free — `a/../../etc/passwd` normalizes during resolution and lands outside the directory. Names are then HTML-unescaped and percent-decoded, and admitted only as single safe path segments; the decode order is load-bearing, since `%2e%2e%2f` survives URL parsing intact and becomes `../` only afterward.

### D5 — run_inflexa spawns the child in the analysis's folder

For "download geo dataset GSE12345" to land in the chat analysis's folder with no ref, the subprocess has to start in the right place. `run_inflexa`'s `execute(input, ctx)` already holds `ctx.session`, so when the scope is analysis-kind it resolves that analysis's anchor folder and passes it as the child's working directory. The child then behaves exactly as if the user had `cd`'d there, and the ordinary `.inflexa` marker walk-up does the rest.

This replaces an earlier design that injected the analysis **id** as `INFLEXA_ANALYSIS` and gave `resolveContext` an ambient precedence tier to honor it. That machinery resolved an id, looked it up in the database, and resolved its anchor row — to obtain the folder it could have simply been handed. `resolveTargetFolder` never read the analysis at all; both of its branches returned `ctx.anchorPath`. Setting the working directory is strictly smaller (it deletes `ContextFlags.ambientAnalysis`, the resolver tier, `ambientAnalysisRef`, the environment variable, and both spec deltas) and strictly more general: it fixes the working directory for *every* command the agent runs, where the ambient tier only helped commands that opted into it — one command, in practice. The trust property is unchanged and arguably stronger: the host picks the folder from the session scope, and the model cannot name a different analysis because no channel exists to name one through.

*Alternative — inject `--analysis <id>` into argv:* rejected — it breaks the commander parse for commands that do not accept `--analysis` (`--help`, `refs list`), and it would clutter the approval prompt the user must read with a machine id. *Alternative — leave the child to inherit the host's cwd:* rejected — that is what the bug was; the host's directory is the folder `inflexa` was started in, which stops matching the open analysis after a resume, an `--analysis` launch, or a mid-session swap.

**Accepted trade-off:** a relative path in an agent-run command now resolves against the analysis's folder rather than the launch folder. That is the more defensible reading of "run this command for this analysis", and the two coincide in the common flow; where they differ, the launch folder was never the more meaningful of the two. It leaves the launch folder reachable exactly where it already was — `list_launch_dir` runs in the host process and reads *its* working directory, which this change does not touch — so the two scopes the agent is taught to distinguish stay distinct: the launch folder is where unstaged input candidates are discovered, the analysis folder is where a command for that analysis operates. The one shape to watch is an agent listing the launch folder and then feeding a relative path from that listing to a subprocess; no agent-reachable command takes file paths today (`inputs add` is `blocked`), so nothing exercises it.

**Known limitation:** a working directory cannot disambiguate *which* analysis when one folder holds several — for that, only an id would do. Nothing needs it today, and this command never will, because it wants a folder.

### D6 — Classified `approval`; agent reaches it via run_inflexa

The command writes files, so per `agent-command-policy` it is `approval` — never `auto`. The conversation agent invokes it through the existing `run_inflexa` subprocess tool, which classifies it by the commander parse and shows the in-chat approval prompt. No new agent tool.

### D7 — Retry, because the upstream sheds load by refusing

NCBI answers 403 both for a directory with no index and, intermittently, for a request it is shedding — the same status, the same body, observed flapping 200↔403 on identical URLs seconds apart. The two cannot be told apart in the moment, so requests retry with exponential backoff and are spaced; a throttled request recovers within a couple of attempts, while a genuinely empty directory answers 403 every time and the settled answer is read as "nothing here". An absent or unreadable directory contributes nothing rather than failing the whole resolution.

### D8 — Transfer to staging, place on full success

Artifacts land in a staging directory beside the destination and move into place only once the whole set has transferred. A failed run therefore creates no destination directory and retains no partial set — important because the destination is the user's own data folder, and littering it with the debris of an aborted attempt is worse than failing cleanly.

### D9 — The subprocess bound is silence, not duration

`run_inflexa` bounded a child by wall-clock, which cannot distinguish a command that is working from one that is wedged — so every value was wrong for someone: 120 s killed a legitimate multi-gigabyte download, and a ceiling generous enough to spare it would have let a hung command hold the turn just as long. The bound is now the gap between output (`idleTimeoutMs`, 120 s, rearmed on every chunk either stream produces), with a 30-minute absolute backstop for the case the idle clock cannot see — a command looping forever while printing.

Rearming is why `geo add` emits a `file_progress` heartbeat every 5 s: a single large artifact would otherwise transfer in total silence and read as hung. The heartbeat is the readout a long download needed regardless, so the timeout requirement and the UX requirement are satisfied by the same event. Activity is noted before the output cap is applied — past the cap the bytes are dropped, but they are still evidence the child is alive, and a command must not die for being chatty.

### D10 — Subcommand options are read with `optsWithGlobals()`

The root declares `--analysis`/`--project` for the bare-`inflexa` flow, and commander lets a program option appear anywhere on the line — so for `inflexa profile --analysis x` the value binds to the ROOT and the subcommand's identically-named option never receives it. Six commands took the flag and ignored it in silence, and the ambient `INFLEXA_ANALYSIS` tier could not be overridden by the flag this change's own spec says outranks it. `registerAction` — the single sanctioned way to attach an action — now hands handlers `optsWithGlobals()`, fixing every command at one choke point with a subcommand's own value still winning when it has one.

*Alternative — `enablePositionalOptions()`:* rejected, and this is the second time. It binds an option to whichever command precedes it, which fixes the shadowing but makes a root-style flag placed after a subcommand (`inflexa sessions --project x`) a hard "unknown option" error, breaking invocations users already rely on. A regression test in `cli.test.ts` pins that shape precisely because the approach was tried and reverted once before; both halves of the trade-off are now pinned there.

### D11 — A shared transfer utility, extracted but not yet deduped

`src/lib/download.ts` (`downloadToFile` + `declaredContentLength`: HTTPS re-checked on the post-redirect URL, sha256, `.part`→atomic activation, progress, injected `fetch`) is factored out for this command to use. `refs/store.ts` still carries its own equivalent; repointing it is tracked as task 1.2 and is deliberately not a blind swap — refs treats the `.part` itself as the durable artifact in a separate downloads directory and reclaims it by name, guards its destination with `assertOwnedPath`, and carries a different error union. Until that lands, the extraction has one caller and the duplication is real rather than notional.

## Risks / Trade-offs

- **Large downloads** — the command HEAD-probes the set for a size estimate before transferring, honors a cap that `--max-size` can raise, and reports per-file progress plus a heartbeat; the `approval` prompt is the user's gate.
- **Autoindex enumeration depends on a served HTML shape.** Resolving links rather than pattern-matching them removes the fragility that actually bit, and the tests pin it against captured real responses, but a wholesale change to how NCBI serves directories would still need a code change.
- **No GEO-specific parsing library is needed** → the series matrix is plain TSV with a `!`-prefixed metadata preamble and supplementary files are ordinary processed matrices, all readable by the general tools already in the lib store (pandas/numpy/scanpy/anndata, data.table/readr). GEOparse/GEOquery are download-and-parse convenience libraries whose network half is replaced host-side; requiring them would add an unnecessary lib-store dependency and hardcode a tool into agent-facing content.

## Migration Plan

Additive — no breaking changes, no harness change, no lib-store change. Order: (1) the shared transfer utility; (2) the GEO source module (accession→URL resolution, enumeration, staged transfer); (3) the `approval` command with full help text; (4) the `agent-command-policy` snapshot row. Rollback is unregistering the command.

## Open Questions

- **Cross-invocation caching** keyed by accession, once something reference-counts the bytes.
- **Re-download behavior** — re-running for an accession already on disk currently re-fetches every byte.
