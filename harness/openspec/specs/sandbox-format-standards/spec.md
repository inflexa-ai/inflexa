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

The per-step prompt builder, `renderStepPrompt(step)`
(`harness/src/schemas/render-step-prompt.ts`), folds the plan step's
instruction-bearing fields into the agent's initial message and carries **no**
path teaching — there is no Paths block and no literal `resourceId`/`runId`/`stepId`.
Path orientation is supplied once, by `sandboxOrientCorePrompt`, through the
`{{WORKING_DIR}}` and `{{ANALYSIS_ROOT}}` placeholders that `createSandboxAgent`
substitutes with the agent's concrete paths.

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

### Requirement: The orient prompt teaches the path model via placeholders

`sandboxOrientCorePrompt` SHALL teach the sandbox filesystem layout, and
`createSandboxAgent` SHALL substitute its `{{WORKING_DIR}}` and `{{ANALYSIS_ROOT}}`
placeholders with the agent's concrete paths. The prompt SHALL state that the
working directory is the writable root, that relative paths resolve against it,
that a write outside it returns an `out_of_prefix` result, that the rest of the
analysis is mounted read-only at the analysis root and reached by absolute path,
and that shell `cd` does not persist across `execute_command` calls.

#### Scenario: Working directory and read-only root are taught

- **WHEN** a sandbox agent's system prompt is assembled
- **THEN** the orient prompt names the working directory (`{{WORKING_DIR}}` substituted) as the writable root
- **AND** states the analysis root (`{{ANALYSIS_ROOT}}` substituted) is read-only and reached by absolute path

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

### Requirement: renderStepPrompt carries instructions only, no path block

`renderStepPrompt(step)` SHALL compose the agent's initial prompt from the plan
step's instruction-bearing fields (`name`, `question`, `description`, `context`,
`constraints`, `acceptance_criteria`, `caveats`), skipping empty fields. It SHALL
NOT emit a Paths block and SHALL NOT include literal `resourceId`/`runId`/`stepId`
values — path orientation is owned solely by `sandboxOrientCorePrompt`.

#### Scenario: Rendered step prompt has no path block

- **WHEN** `renderStepPrompt(step)` is invoked
- **THEN** the output contains the step's task and populated instruction sections
- **AND** contains no Paths block and no literal `resourceId`/`runId`/`stepId`

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

The `data-profiler` agent prompt SHALL orient via the workspace tools under the
shared orient-first discipline rather than shelling out with `cd`/`ls`
(`harness/src/prompts/sandbox/data-profiler.ts`). It directs the agent to
`list_files` with `path: "data/inputs"` and `maxDepth: 3` for the orientation
pass.

#### Scenario: Data-profiler orientation uses list_files

- **WHEN** the data-profiler prompt is read
- **THEN** it directs the agent to `list_files` with `path: "data/inputs"` and `maxDepth: 3` for the orientation pass
