# sandbox-format-standards Specification

## Purpose

Defines the shared standards every sandbox agent applies — language policy, data
containers, file/figure formats, metadata placement, the filesystem path model,
and command-execution discipline — so per-agent prompts only add domain-specific
guidance on top. These standards live in two prompt layers
(`harness/src/prompts/sandbox-standards.ts`): `sandboxOrientCorePrompt`, appended
to every sandbox agent and the home of the path model and tool-use discipline;
and `sandboxAnalysisStepStandardsPrompt`, appended only to plannable
analysis-step agents (opt-out via `appendAnalysisStepStandards: false`) and the
home of the language/data/figure conventions and the five-subdirectory layout.

Neither prompt layer names a concrete path, id, or any other per-step value, and
neither carries a placeholder for one. The system prompt `createSandboxAgent`
composes is a **pure function of the agent type**: two steps of one run, and two
runs of one analysis, send a byte-identical prefix. That is a caching property,
not a style rule — a per-step-unique system string cannot be reused by the
provider's prompt cache, so every step would pay a full cache write and read
nothing back.

The concrete paths therefore ride in the step's **seed** — its first user message,
composed per dispatch by `composeStepBriefing` (`harness/src/prompts/briefing.ts`),
whose `renderWorkspace` section names the in-sandbox working directory and the
read-only analysis root. The prompt layers teach the path *model*; the seed
supplies the *paths*.
## Requirements
### Requirement: Python-first language policy

All sandbox agents SHALL use Python as the default programming language. R SHALL
be used only when (a) no adequate Python equivalent exists, (b) the R
implementation is significantly more mature or validated, or (c) the task
explicitly requires an R-only package. Isolated R calls in a Python pipeline
SHALL use the rpy2 bridge; an R-dominant pipeline MAY be written as native R
scripts following the same standards.

#### Scenario: Agent defaults to Python for DE analysis on RNA-seq

- **WHEN** the `bulk-transcriptomics-agent` is asked to perform differential expression on a count matrix
- **THEN** it uses a Python method (e.g. PyDESeq2) as the default
- **AND** falls back to DESeq2 via rpy2 only if the Python method lacks a required feature

#### Scenario: Agent uses R when no Python equivalent exists

- **WHEN** the `dna-methylation-agent` preprocesses 450K/EPIC methylation array data
- **THEN** it uses minfi (no adequate Python equivalent)
- **AND** converts results back to AnnData/pandas for downstream steps

#### Scenario: R-dominant pipeline uses native R, not whole-pipeline rpy2

- **WHEN** an agent runs an R-dominant pipeline (e.g. DADA2 → phyloseq → vegan → ANCOM-BC2)
- **THEN** it writes native R scripts rather than wrapping the entire pipeline in rpy2

### Requirement: AnnData/MuData as universal data containers

All sandbox agents SHALL use AnnData (.h5ad) as the universal container for
sample-by-feature data across all modalities, and MuData (.h5mu) for multi-modal
data. Intermediate analysis objects SHALL be saved as `.h5ad`/`.h5mu`, never as
`.rds` or `.pkl`. Genomic variant data MAY use VCF/BED/BAM as primary containers,
with derived summary statistics in AnnData or CSV.

#### Scenario: Bulk RNA-seq data stored in AnnData

- **WHEN** the `bulk-transcriptomics-agent` processes bulk RNA-seq data
- **THEN** it stores it as AnnData with samples in `.obs`, genes in `.var`, and values in `.X`

#### Scenario: MuData used for multi-modal single-cell data

- **WHEN** the `multimodal-sc-agent` processes CITE-seq data (RNA + protein)
- **THEN** it stores it as MuData with a separate AnnData modality per assay and shared sample metadata at the MuData level

#### Scenario: Intermediate objects saved as h5ad/h5mu, not rds or pkl

- **WHEN** any sandbox agent saves intermediate objects for downstream steps
- **THEN** it saves them as `.h5ad` or `.h5mu`, not `.rds` or `.pkl`

### Requirement: Output format standards

All sandbox agents SHALL follow standardized output conventions: figures saved
as PNG at 300 DPI minimum AND a vector PDF (same base name); colorblind-safe
palettes (viridis family default, never red-green as the sole distinguisher);
clean minimal themes with complete labels; tabular results as CSV with
human-readable column names.

#### Scenario: Figures saved as PNG and PDF

- **WHEN** any sandbox agent generates a figure
- **THEN** it saves a PNG at ≥300 DPI and a vector PDF with the same base name

#### Scenario: Tabular results saved as descriptive CSV

- **WHEN** any sandbox agent produces tabular results
- **THEN** it saves them as CSV with descriptive column names (e.g. `log2_fold_change`, `adjusted_pvalue`)

### Requirement: Metadata in obs/var, not separate files

All sandbox agents SHALL store sample and feature metadata within the
AnnData/MuData object's `.obs` and `.var` DataFrames, not as separate CSV files,
so metadata travels with the data through the pipeline.

#### Scenario: Analysis results stored in the AnnData object

- **WHEN** the `single-cell-agent` performs clustering
- **THEN** cluster assignments are stored in `.obs` and UMAP coordinates in `.obsm['X_umap']`
- **AND** they are NOT written as separate CSV files for the result itself (a summary CSV for human readability is allowed)

### Requirement: The orient prompt teaches the path model without naming a path

`sandboxOrientCorePrompt` SHALL teach the sandbox filesystem layout in terms of
the *roles* — "your working directory", "the analysis root" — and SHALL NOT name
a concrete path, id, or placeholder for one. It SHALL state that the working
directory is writable and is the agent's cwd, that relative paths resolve against
it in every workspace tool and every script, that a write outside it returns an
`out_of_prefix` result, that the rest of the analysis is mounted read-only at the
analysis root and reached by absolute path, that absolute analysis-root paths are
canonical for any file the step did not create, and that shell `cd` does not
persist across `execute_command` calls. It SHALL direct the agent to the paths its
briefing names rather than to invent or guess one.

#### Scenario: The path model is taught by role, not by value

- **WHEN** a sandbox agent's system prompt is assembled
- **THEN** the orient prompt names the working directory as the writable cwd and the analysis root as the read-only mount reached by absolute path
- **AND** it contains no concrete path, no `resourceId`/`runId`/`stepId`, and no unsubstituted placeholder

#### Scenario: cd non-persistence is taught

- **WHEN** the orient prompt is read
- **THEN** it states `cd` does NOT persist across calls and directs the agent to pass `cwd` or chain with `&&`

### Requirement: The five writable subdirectories are taught for analysis steps

`sandboxAnalysisStepStandardsPrompt` SHALL describe the working directory's five
artifact subdirectories — `scripts/`, `output/`, `figures/`, `logs/`,
`notebooks/` — and direct each kind of artifact to its own.

#### Scenario: Subdirectories named

- **WHEN** a plannable analysis-step agent's prompt is assembled
- **THEN** it names `scripts/`, `output/`, `figures/`, `logs/`, and `notebooks/` as the writable subdirectories

### Requirement: The step seed carries the concrete paths, not the system prompt

The step's seed — its sole initial user message — SHALL be composed by
`composeStepBriefing` (`harness/src/prompts/briefing.ts`) from the plan step's
instruction-bearing fields (`name`, `question`, `description`, `context`,
`constraints`, `acceptance_criteria`, `caveats`, skipping empty ones) plus a
Workspace section rendered by `renderWorkspace({ analysisRoot, workingDir })` that
names both in-sandbox paths verbatim. Every per-step value the agent needs — the
paths, the dataset orientation, and what each completed dependency produced —
SHALL ride here and NOWHERE in the system prompt, so the composed `systemPrompt`
stays a pure function of the agent type and the provider's prompt cache can reuse
its prefix across every step of every run.

#### Scenario: The seed names both paths

- **WHEN** `composeStepBriefing` is invoked for a dispatched step
- **THEN** its Workspace section names the writable working directory (the agent's cwd) and the read-only analysis root
- **AND** the task sections carry only the step's populated instruction fields

#### Scenario: The system prompt is byte-identical across steps

- **GIVEN** two different steps of the same run built with the same sandbox agent type
- **WHEN** their `AgentDefinition.systemPrompt` strings are compared
- **THEN** they SHALL be byte-identical, carrying no path, id, or unsubstituted placeholder

### Requirement: Command-execution discipline keeps execute_command primary

The Command Execution section of `sandboxOrientCorePrompt` SHALL frame
`execute_command` as the primary way to run scripts, bioinformatics CLI tools,
and shell pipelines — not a fallback — while redirecting a fixed set of
operations to dedicated workspace tools: `list_files` instead of `ls`/`find -name`,
`read_file` instead of `cat`/`less`, `grep` (ripgrep-based content search)
instead of shell `grep`/`rg`, and `file_stat` instead of `stat`/`wc -c`. The
section SHALL preserve legitimate exec uses (running scripts, previewing
huge/binary files, shell pipes, `find` with non-name predicates, real CLI tools)
and is the sole steering mechanism — there is no tool-description override layer.

#### Scenario: execute_command framed as the primary runner

- **WHEN** a sandbox agent reads the Command Execution section
- **THEN** it describes `execute_command` as the primary runner for scripts, CLI tools, and shell pipelines, not a fallback

#### Scenario: Operations redirected to workspace tools

- **WHEN** a sandbox agent reads the Command Execution section
- **THEN** it directs the agent to `list_files`, `read_file`, `grep`, and `file_stat` in place of the corresponding shell idioms

#### Scenario: Legitimate exec uses preserved

- **WHEN** the section lists exec-appropriate operations
- **THEN** it includes running scripts, previewing huge/binary files, shell pipes, `find` with non-name predicates, and real CLI tools

### Requirement: Data-profiler orients via workspace tools, not cd and ls

The `data-profiler` agent prompt SHALL orient from the input scan manifest carried in its
briefing (see the input-scan-manifest spec) rather than by enumerating the tree itself, and
where it does need to explore it SHALL use the workspace tools rather than shelling out with
`cd`/`ls` (`harness/src/prompts/sandbox/data-profiler.ts`).

The manifest is the orientation pass. It is produced deterministically before the agent's
first turn and already carries the tree's kinds, axes, formats, and counts, so an agent that
began by listing the tree would spend turns rediscovering what it was handed.

For exploration beyond the manifest the prompt SHALL direct the agent to `scan_inputs` with a
path to re-scan a subtree, or to `list_files` with `path: "data/inputs"`, recursing by calling
it again on a subdirectory it returned — `path` is `list_files`' only parameter, so there is
no depth argument to pass.

#### Scenario: Data-profiler orientation uses the manifest

- **WHEN** the data-profiler prompt is read
- **THEN** it directs the agent to orient from the input scan manifest in its briefing
- **AND** it does not direct the agent to enumerate the input tree as its orientation pass

#### Scenario: Exploration beyond the manifest uses workspace tools

- **WHEN** the data-profiler prompt directs exploration beyond the manifest
- **THEN** it names `scan_inputs` with a path, or `list_files` with `path: "data/inputs"`
- **AND** it names no second `list_files` parameter, because the tool declares none

### Requirement: The data-profiler prompt states that profiling is orientation, not quality control

The `data-profiler` prompt SHALL state its purpose: it produces the dataset's orientation
record — what the data *is*, so planning can proceed — and it does not perform quality
control, which belongs to analysis steps.

The prompt SHALL carry an explicit prohibition on per-file statistical quality work,
naming the measures it excludes: transition/transversion ratios, allele-frequency spectra,
replicate correlation, principal-component outlier detection, coverage depth, mapping rate,
duplicate rate, insert-size distribution, and GC bias. It SHALL NOT carry per-format
quality checklists.

The governing rule SHALL be that a check earns its place if it answers *what is this* and
not if it answers *is this good*. Whether a matrix holds raw or normalised counts is
identity and is kept; the zero-inflation level of that matrix is a verdict on quality and
is not. The distinction matters because the excluded measures require decoding files in
full, which is what made profiling cost scale with input size, and no consumer of the
profile reads them.

The prompt SHALL direct the agent that where a kind's description depends on content the
scan did not capture, it inspects **one** example file of that kind — not one per member.

#### Scenario: The prompt states the purpose

- **WHEN** the data-profiler prompt is read
- **THEN** it SHALL state that the profile is an orientation record and that quality control belongs to analysis steps

#### Scenario: The prompt excludes per-file quality measures

- **WHEN** the data-profiler prompt is read
- **THEN** it SHALL NOT instruct the agent to compute transition/transversion ratios, allele-frequency spectra, replicate correlation, principal-component outlier detection, coverage depth, mapping rate, duplicate rate, insert-size distribution, or GC bias

#### Scenario: Sampling is per kind, not per member

- **GIVEN** a kind of 1171 members
- **WHEN** the agent needs content the scan did not capture
- **THEN** the prompt SHALL direct it to inspect one example file rather than one file per member

