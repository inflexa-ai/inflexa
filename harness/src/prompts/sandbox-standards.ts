/**
 * Sandbox prompts — split into two layers, both STATIC.
 *
 * - `sandboxOrientCorePrompt` — the facts of the sandbox for each agent that
 *   runs commands in it (plannable steps and the data profiler): no network, no
 *   installs, and the installed command-line tools. Always appended by
 *   `createSandboxAgent`. A tool rule lives in the description of its tool, and
 *   the path model lives in the file tools, which agents without a sandbox hold too.
 *
 * - `sandboxAnalysisStepStandardsPrompt` — the contract of a plannable analysis
 *   step with the harness and with the steps after it: the briefing, the scope,
 *   the output contract, the data formats, the directories, and the findings.
 *   How the agent works (the language, the scripts, the figures) is not part
 *   of it: that belongs to the agent body. Opt out via
 *   `appendAnalysisStepStandards: false` for agents that don't fit this mold
 *   (for example data-profiler, whose first message is no step briefing).
 *
 * Neither layer names a concrete path, id, or any other per-step value, and
 * neither carries a placeholder for one. That is load-bearing rather than
 * stylistic: it is what makes the `systemPrompt` `createSandboxAgent` composes a
 * pure function of the agent type, so every step of every run of a given agent
 * sends a byte-identical prefix and the provider's prompt cache can hit it. The
 * volatile particulars — working directory, analysis root, dataset, upstream
 * results — ride in the step's briefing (its first user message; see
 * `prompts/briefing.ts`), which is composed per dispatch and where per-step
 * content belongs.
 *
 * The orient-core text keys on the `toolchainSource` of the sandbox client
 * (`sandboxOrientCorePromptFor`). `"store"` gives the legacy constant
 * untouched, thus an embedder that declares no toolchain keeps its cached
 * prefix byte-identical. Both variants are composition-time constants, thus
 * each composition stays byte-stable across its own steps.
 */

import type { ToolchainSource } from "../sandbox/types.js";

export const sandboxOrientCorePrompt = `# Sandbox Environment

Your commands run in a sandbox with no network: each download, API call, and
package install fails, and no retry succeeds. Packages and reference
data were staged onto read-only mounts by the host **before** this container
started, and that is the whole of what exists. A lookup of an outside source
runs on the host, in \`run_script\`.

\`samtools\`, \`bcftools\`, \`tabix\`, \`bedtools\`, and \`vcftools\` are installed.
`;

/**
 * Swap one exact clause of the legacy orient-core for its image-toolchain
 * form. The needle must occur exactly once — a moved or duplicated clause
 * throws at module load, thus a silent drift of the variant is impossible.
 */
function replaceExactlyOnce(haystack: string, needle: string, replacement: string): string {
    const first = haystack.indexOf(needle);
    if (first < 0 || haystack.indexOf(needle, first + 1) >= 0) {
        throw new Error("sandbox-standards: an orient-core clause moved — update the image-toolchain variant beside it");
    }
    return haystack.slice(0, first) + replacement + haystack.slice(first + needle.length);
}

const imageToolchainOrientCorePrompt = replaceExactlyOnce(
    sandboxOrientCorePrompt,
    `Packages and reference
data were staged onto read-only mounts by the host **before** this container
started, and that is the whole of what exists.`,
    `The packages of your farm and the reference
data were staged onto read-only mounts by the host **before** this container
started. An acquisition of a new package is a host action, done outside this
sandbox.`,
);

/**
 * The orient-core layer for one declared toolchain. `"image"` states that an
 * acquisition is a host action. `"store"` gives the base constant untouched.
 * Neither variant tells the agent when to report a package missing: the
 * description of `list_available_packages` carries that rule, and it changes
 * with the farm extension, which this text does not key on.
 */
export function sandboxOrientCorePromptFor(toolchainSource: ToolchainSource): string {
    return toolchainSource === "image" ? imageToolchainOrientCorePrompt : sandboxOrientCorePrompt;
}

export const sandboxAnalysisStepStandardsPrompt = `# Sandbox Analysis-Step Conventions

## Your Briefing

Your first message is your briefing: the task, your working directory, the
inputs, and what each step before you produced. Work from it, and do not derive
again what it gives you. Reach further only where it is thin:
\`inspect_data_profile\` for the dataset, \`read_file\` on an upstream summary,
and \`workspace_search\` for a file that it does not name.

## Scope

This environment turns processed data into findings: count and expression
matrices, called variants, peak sets, signal tracks, and their metadata. Read
processing (alignment, quantification, variant calling, peak calling) belongs
upstream, and no tool for it is installed. When a request arrives as raw reads
or instrument output, name the processed form that you need and stop. Do not
improvise a pipeline.

## Output Contract

Your deliverable is persisted files in your working directory:

\`\`\`
scripts/    the scripts that you wrote (.py, .R)
output/     the data that they computed: CSV, AnnData (.h5ad), MuData (.h5mu), JSON
figures/    the figures
logs/       the logs of long-running commands
notebooks/  reserved
\`\`\`

Draw each conclusion from those files, never from stdout. A step that ends
without persisted scripts and outputs produced nothing. A verdict with no table
can be a short Markdown memo in \`output/\`.

## Data Formats

The later steps read AnnData, MuData, and CSV:

- Sample-by-feature data of any modality goes in AnnData: samples in \`.obs\`,
  features in \`.var\`, values in \`.X\`, and the metadata in \`.obs\` and
  \`.var\`, not in a separate CSV. Multi-modal data goes in MuData.
- Convert an R object (DESeqDataSet, phyloseq, SingleCellExperiment) back to
  AnnData or a table. Do not save \`.rds\` or \`.pkl\`.
- Tables are CSV with readable column names (\`log2_fold_change\`, not \`lfc\`).
  With a modality-specific result, also write a generic CSV.
- VCF, BED, and BAM stay as they are. Derived statistics go to AnnData or CSV.

## Findings

State each finding with the numbers that support it and the file that holds
them.
`;
