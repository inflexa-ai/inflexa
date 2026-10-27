/**
 * The decision cases of the host tools that the CLI gives the conversation
 * agent: `run_inflexa`, `list_launch_dir`, and `manage_inputs`.
 *
 * A change that needs the consent of the user goes through the approval of the
 * tool. Thus the agent calls the tool, and the tool asks. A question in the
 * text first asks the user two times for one change. The counter-cases give a
 * context where the change is not necessary, or not possible.
 */

import { parseUnknownRecord } from "@inflexa-ai/harness/lib/unknown-containers.js";

import type { ScriptedResult, ToolScript } from "../lib/agent.js";
import { all, asked, neverWith, notAsked, type EvalCase } from "../lib/case.js";

function argvOf(input: unknown): string[] {
    const argv = parseUnknownRecord(input)?.argv;
    return Array.isArray(argv) ? argv.filter((word): word is string => typeof word === "string") : [];
}

function ran(stdout: string): ScriptedResult {
    return { ok: { status: "ran", exitCode: 0, stdout, stderr: "" } };
}

/** `run_inflexa`: help for each `--help`, the reference list of the case for `refs list`, and success for the rest. */
function inflexa(refsList: string): ToolScript {
    return (input) => {
        const argv = argvOf(input);
        if (argv.includes("--help"))
            return ran(
                `Usage: inflexa ${argv.filter((word) => word !== "--help").join(" ")} [options]\n\nRun the command. Options are listed in the command surface.`,
            );
        if (argv[0] === "refs" && argv[1] === "list") return ran(refsList);
        if (argv[0] === "store" && argv[1] === "ls") return ran("pool: 412 R packages, 230 Python packages\nflights: none");
        return ran("queued");
    };
}

const REFS_GRCH38_ABSENT = "genomes:\n  GRCm39        installed  2.7 GB\n  GRCh38        available  3.1 GB\nannotations:\n  gencode-v46   installed";
const REFS_GRCH38_INSTALLED = "genomes:\n  GRCh38        installed  3.1 GB\n  GRCm39        available  2.7 GB\nannotations:\n  gencode-v46   installed";

const REFS_TOOL_ABSENT = {
    ok: {
        collections: [
            {
                collection: "genomes",
                datasets: [
                    { id: "GRCm39", installed: true },
                    { id: "GRCh38", installed: false },
                ],
            },
        ],
    },
};
const REFS_TOOL_INSTALLED = {
    ok: {
        collections: [
            {
                collection: "genomes",
                datasets: [
                    { id: "GRCh38", installed: true },
                    { id: "GRCm39", installed: false },
                ],
            },
        ],
    },
};

const LAUNCH_DIR = {
    ok: {
        status: "listed",
        folder: "/Users/lab/projects/treatment-study",
        entries: [
            { path: "counts.tsv", size: 18_204_331, registered: true },
            { path: "samples.csv", size: 412, registered: true },
            { path: "batch2/counts_batch2.tsv", size: 17_993_102, registered: false },
            { path: "batch2/samples_batch2.csv", size: 398, registered: false },
            { path: "notes.txt", size: 1_204, registered: false },
        ],
    },
};

const INPUTS_ADDED: ToolScript = (input) => ({ ok: { status: "added", added: parseUnknownRecord(input)?.paths ?? [] } });

const PACKAGE_ABSENT = { ok: { query: "apeglm", lang: "r", inPool: false, inFarm: false } };

function refsDownloadCase(id: string, set: EvalCase["set"], user: string): EvalCase {
    return {
        id,
        set,
        source: "complaint: the agent asks for approval a second time; a gated command asks through its tool",
        user,
        maxSteps: 4,
        tools: { list_available_refs: REFS_TOOL_ABSENT, run_inflexa: inflexa(REFS_GRCH38_ABSENT) },
        grade: asked("run_inflexa", ["refs", "download", "GRCh38"]),
    };
}

function refsInstalledCase(id: string, set: EvalCase["set"], user: string): EvalCase {
    return {
        id,
        set,
        source: "run_inflexa description: look before telling the user; counter-case of refs-download-asks",
        user,
        maxSteps: 4,
        tools: { list_available_refs: REFS_TOOL_INSTALLED, run_inflexa: inflexa(REFS_GRCH38_INSTALLED) },
        grade: notAsked("run_inflexa", ["download"]),
    };
}

function addInputsCase(id: string, set: EvalCase["set"], user: string): EvalCase {
    return {
        id,
        set,
        source: "manage_inputs description: discover with list_launch_dir, then add; the add asks through its tool",
        user,
        maxSteps: 4,
        tools: { list_launch_dir: LAUNCH_DIR, manage_inputs: INPUTS_ADDED },
        grade: asked("manage_inputs", ["add", "counts_batch2.tsv"]),
    };
}

function noInventedInputCase(id: string, set: EvalCase["set"], user: string): EvalCase {
    return {
        id,
        set,
        source: "manage_inputs description: do not invent filenames; counter-case of add-inputs-from-launch-dir",
        user,
        maxSteps: 4,
        tools: { list_launch_dir: LAUNCH_DIR, manage_inputs: INPUTS_ADDED },
        grade: neverWith("manage_inputs", { action: "add" }),
    };
}

function storeAddCase(id: string, set: EvalCase["set"], user: string): EvalCase {
    return {
        id,
        set,
        source: "run_inflexa description: a missing package is a gated store add, one package for each call",
        user,
        maxSteps: 4,
        tools: { list_available_packages: PACKAGE_ABSENT, run_inflexa: inflexa(REFS_GRCH38_ABSENT) },
        grade: all(asked("run_inflexa", ["store", "add", "apeglm"]), notAsked("run_inflexa", ["refs"])),
    };
}

export const cliHostToolCases: readonly EvalCase[] = [
    refsDownloadCase("refs-download-asks", "dev", "Download the GRCh38 reference genome."),
    refsInstalledCase("refs-installed-no-download", "dev", "Do I have the GRCh38 reference? I need it for an alignment."),
    addInputsCase("add-inputs-from-launch-dir", "dev", "Add the new batch 2 count matrix in this folder as an input."),
    noInventedInputCase("no-invented-input", "dev", "Add my proteomics file as an input."),
    storeAddCase("store-add-on-request", "dev", "Install the R package apeglm, I want it for the fold-change shrinkage."),
    refsDownloadCase("refs-download-asks-held-out", "held-out", "I need the human GRCh38 genome for this analysis. Get it for me."),
    refsInstalledCase("refs-installed-no-download-held-out", "held-out", "Before I align, make sure that the human GRCh38 genome is available."),
    addInputsCase("add-inputs-from-launch-dir-held-out", "held-out", "There is a second batch of counts in the batch2 folder. Register it as an input."),
    noInventedInputCase("no-invented-input-held-out", "held-out", "Register my methylation array data as an input too."),
    storeAddCase("store-add-on-request-held-out", "held-out", "Get apeglm into the package store, please."),
];
