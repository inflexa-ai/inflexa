/**
 * A sandbox step agent in a trial, with no sandbox.
 *
 * Each trial gets a throwaway analysis tree on the host, and the agent of the case is built over it with the same
 * factory as the CLI. The workspace tools, the package listing, the link tool, the skill tools, and `report_blocker`
 * are real. Only the exec of a command is scripted: a case rule, else a default rule, gives the exit code, the output,
 * and the files that the command writes. A command is never run on the host, because its argv is model output.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { okAsync } from "neverthrow";

import { createSandboxAgents, type SandboxAgentDeps } from "@inflexa-ai/harness/agents/sandbox/index.js";
import { createPool } from "@inflexa-ai/harness/lib/storage.js";
import type { ToolOutputStore } from "@inflexa-ai/harness/loop/tool-output.js";
import type { AgentDefinition } from "@inflexa-ai/harness/loop/types.js";
import { unusedChatProvider } from "@inflexa-ai/harness/providers/__fixtures__/chat-provider.js";
import { leaseOverClient } from "@inflexa-ai/harness/sandbox/__fixtures__/leases.js";
import { FARM_LOCK_FILE } from "@inflexa-ai/harness/sandbox/farm.js";
import { createFileMetadataCell } from "@inflexa-ai/harness/tools/sandbox/submit-file-metadata.js";
import type { PackageQuery } from "@inflexa-ai/harness/sandbox/package-identity.js";
import type { ExecRequest, ExecResult, PackageRequestOutcome } from "@inflexa-ai/harness/sandbox/types.js";
import { DATA_PROFILE_RUN_LITERAL } from "@inflexa-ai/harness/contracts/data-profile.js";
import { buildSetMenu } from "@inflexa-ai/harness/input-scan/menu.js";
import { scanInputTree } from "@inflexa-ai/harness/input-scan/scan.js";
import { detectSets } from "@inflexa-ai/harness/input-scan/detect-sets.js";
import { makeSession } from "@inflexa-ai/harness/providers/__fixtures__/session.js";
import { composeProfilerSeed, createSubmitProfileTool } from "@inflexa-ai/harness/tasks/data-profile.js";
import { createWorkspaceFilesystem } from "@inflexa-ai/harness/workspace/filesystem.js";

export const ANALYSIS_ID = "analysis-001";
export const RUN_ID = "run-001";

const REPO = join(import.meta.dir, "..", "..");

/** The in-sandbox mount of the reference store. */
const REFS_MOUNT = "/mnt/refs";
const TRIALS_DIR = join(REPO, "tmp", "evals", "sandbox");

/** A package of the farm lock of a trial. */
export type LockedPackage = { readonly name: string; readonly version: string; readonly track: "python" | "cran" | "bioconductor" };

/** One command as a rule reads it. */
export type ExecView = {
    /** The argv, or the words of the shell line of a one-element command. */
    readonly argv: readonly string[];
    /** The shell line of a one-element command, else the argv joined with spaces. */
    readonly line: string;
    /** The in-sandbox working directory of the command. */
    readonly cwd: string;
    /** The text of an in-sandbox path or of a path relative to `cwd`. Absent when no file is there. */
    readonly read: (path: string) => string | undefined;
    /** The entries of a directory, in the same path forms. Absent when no directory is there. */
    readonly list: (path: string) => readonly string[] | undefined;
};

/** What a scripted command gives. `writes` are files, relative to the working directory of the step, that the command leaves. */
export type ExecReply = {
    readonly exitCode: number;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly writes?: Readonly<Record<string, string>>;
};

/** A rule gives the reply to a command, or nothing when the command is not its own. */
export type ExecRule = (view: ExecView) => ExecReply | undefined;

export type SandboxSetup = {
    readonly agentId: string;
    readonly stepId: string;
    /** The files of the analysis tree before the step, by analysis-relative path. */
    readonly files: Readonly<Record<string, string>>;
    /** The packages that the farm of the analysis holds. */
    readonly packages: readonly LockedPackage[];
    /** The answer of a link of one package. Absent: the package is absent, and no acquisition can bring it. */
    readonly link?: (query: PackageQuery) => PackageRequestOutcome;
    /** The rules of the case, before the default rules. */
    readonly exec?: readonly ExecRule[];
    /** The files of the reference store, by path under `/mnt/refs`. A command reads them there. */
    readonly refs?: Readonly<Record<string, string>>;
};

/** The agent id of the data profiler, which profiles the inputs before any run. */
export const PROFILER_ID = "data-profiler";

/** The analysis-relative working directory of a setup: the step directory of the run, or the scratch of the profiler. */
function workingPathOf(setup: Pick<SandboxSetup, "agentId" | "stepId">): string {
    return setup.agentId === PROFILER_ID ? `runs/${DATA_PROFILE_RUN_LITERAL}/profile` : `runs/${RUN_ID}/${setup.stepId}`;
}

/** The in-sandbox working directory of a setup. */
export function workingDirOf(setup: Pick<SandboxSetup, "agentId" | "stepId">): string {
    return `/${ANALYSIS_ID}/${workingPathOf(setup)}`;
}

/** A sandbox agent in one trial: the agent, the files that the step left, and the commands that no rule answered. */
export type SandboxTrial = {
    readonly agent: AgentDefinition;
    /** The first message of a profiler trial, which the scan of the tree of the trial composes. */
    readonly seed?: string;
    readonly unscripted: readonly string[];
    /** The text of each file under the working directory, by working-directory-relative path. */
    files(): Readonly<Record<string, string>>;
    dispose(): void;
};

const PYTHON_STDLIB = new Set(
    "os sys re json csv math statistics pathlib collections itertools functools typing subprocess shutil glob gzip io argparse datetime time random warnings logging dataclasses textwrap string hashlib copy tempfile zipfile pickle enum abc".split(
        " ",
    ),
);

/** The distribution of a Python import name, where the two differ. */
const PYTHON_DISTRIBUTION: Readonly<Record<string, string>> = { sklearn: "scikit-learn", yaml: "pyyaml", PIL: "pillow", skbio: "scikit-bio" };

const R_BASE = new Set("stats utils methods graphics grDevices base datasets tools parallel grid splines".split(" "));

function words(line: string): string[] {
    return line.split(" ").filter((word) => word.length > 0);
}

/**
 * The simple commands of a shell line, with the quotes of each word removed: each command of a `;`, `&&`, or `||`
 * list, and the first command of each pipe. A separator inside quotes stays in its word.
 */
function shellCommands(line: string): string[][] {
    const commands: string[][] = [];
    let words: string[] = [];
    let word = "";
    let quote: string | undefined;
    let inPipe = false;
    const endWord = (): void => {
        if (word.length > 0 && !inPipe) words.push(word);
        word = "";
    };
    const endCommand = (pipe: boolean): void => {
        endWord();
        if (words.length > 0 && !inPipe) commands.push(words);
        words = [];
        inPipe = pipe;
    };
    for (let i = 0; i < line.length; i += 1) {
        const char = line[i] ?? "";
        const next = line[i + 1] ?? "";
        if (quote !== undefined) {
            if (char === quote) quote = undefined;
            else word += char;
        } else if (char === '"' || char === "'") quote = char;
        else if (char === " " || char === "\n" || char === "\t") endWord();
        else if (char === ";") endCommand(false);
        else if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
            endCommand(false);
            i += 1;
        } else if (char === "|") endCommand(true);
        else word += char;
    }
    endCommand(false);
    return commands;
}

function pythonImports(code: string): string[] {
    const names: string[] = [];
    for (const raw of code.replaceAll(";", "\n").split("\n")) {
        const line = raw.trim();
        const head = line.startsWith("import ") ? line.slice("import ".length) : line.startsWith("from ") ? line.slice("from ".length) : undefined;
        if (head === undefined) continue;
        for (const part of (line.startsWith("from ") ? (words(head)[0] ?? "") : head).split(",")) {
            const name = (words(part.trim())[0] ?? "").split(".")[0] ?? "";
            if (name.length > 0) names.push(name);
        }
    }
    return names;
}

function rLibraries(code: string): string[] {
    const names: string[] = [];
    for (const call of ["library(", "require(", "requireNamespace(", "suppressPackageStartupMessages(library("]) {
        let at = code.indexOf(call);
        while (at !== -1) {
            const rest = code.slice(at + call.length);
            const end = rest.search(/[),]/);
            const name = rest
                .slice(0, end === -1 ? undefined : end)
                .replaceAll('"', "")
                .replaceAll("'", "")
                .trim();
            if (name.length > 0) names.push(name);
            at = code.indexOf(call, at + call.length);
        }
    }
    let at = code.indexOf("::");
    while (at !== -1) {
        let start = at;
        while (start > 0 && /[A-Za-z0-9.]/.test(code[start - 1] ?? "")) start -= 1;
        const name = code.slice(start, at);
        if (name.length > 0) names.push(name);
        at = code.indexOf("::", at + 2);
    }
    return [...new Set(names)];
}

function fold(name: string): string {
    return name.toLowerCase().replaceAll("_", "-").replaceAll(".", "-");
}

/**
 * What an inline `python -c` or `Rscript -e` prints when its imports resolve. An eval cannot compute the output of
 * model code, and an empty output reads as a broken sandbox, thus the run says what it is.
 */
const INLINE_NOTE = "[eval] The inline code ran with exit code 0. This eval does not compute what it prints.";

/** What a script run prints when no rule of the case answers it. */
const SCRIPT_NOTE = "[eval] The script ran with exit code 0. This eval does not compute what it prints or writes.";

/** The default rules: the lint, a run of a Python or R script with the imports checked against the lock, and a read of a file. */
function defaultRules(packages: readonly LockedPackage[]): ExecRule[] {
    const python = new Set(packages.filter((p) => p.track === "python").map((p) => fold(p.name)));
    const r = new Set(packages.filter((p) => p.track !== "python").map((p) => p.name));
    const missingPython = (code: string): string | undefined =>
        pythonImports(code).find((name) => !PYTHON_STDLIB.has(name) && !python.has(fold(PYTHON_DISTRIBUTION[name] ?? name)));
    const missingR = (code: string): string | undefined => rLibraries(code).find((name) => !R_BASE.has(name) && !r.has(name));

    const runPython: ExecRule = ({ argv, read }) => {
        const program = argv[0] ?? "";
        if (program !== "python" && program !== "python3") return undefined;
        if (argv[1] === "--version" || argv[1] === "-V") return { exitCode: 0, stdout: "Python 3.12.7" };
        const code = argv[1] === "-c" ? argv.slice(2).join(" ") : read(argv[1] ?? "");
        if (code === undefined) return { exitCode: 2, stderr: `${program}: can't open file '${argv[1] ?? ""}': [Errno 2] No such file or directory` };
        const missing = missingPython(code);
        if (missing !== undefined) {
            return {
                exitCode: 1,
                stderr: `Traceback (most recent call last):\n  File "<script>", line 1, in <module>\nModuleNotFoundError: No module named '${missing}'`,
            };
        }
        return { exitCode: 0, stdout: argv[1] === "-c" ? INLINE_NOTE : SCRIPT_NOTE };
    };
    const runR: ExecRule = ({ argv, read }) => {
        if (argv[0] !== "Rscript") return undefined;
        if (argv[1] === "--version") return { exitCode: 0, stdout: "Rscript (R) version 4.4.2 (2024-10-31)" };
        const code = argv[1] === "-e" ? argv.slice(2).join(" ") : read(argv[1] ?? "");
        if (code === undefined) return { exitCode: 2, stderr: `Fatal error: cannot open file '${argv[1] ?? ""}': No such file or directory` };
        const missing = missingR(code);
        if (missing !== undefined) return { exitCode: 1, stderr: `Error in library(${missing}) : there is no package called '${missing}'\nExecution halted` };
        return { exitCode: 0, stdout: argv[1] === "-e" ? INLINE_NOTE : SCRIPT_NOTE };
    };
    const lint: ExecRule = ({ argv }) =>
        argv[0] === "ruff" || (argv[0] === "python3" && argv[2] === "ruff") ? { exitCode: 0, stdout: "All checks passed!" } : undefined;
    const readers: ExecRule = ({ argv, read }) => {
        const program = argv[0] ?? "";
        if (!["head", "cat", "wc", "tail"].includes(program)) return undefined;
        const path = argv.slice(1).filter((word) => !word.startsWith("-") && !/^\d+$/.test(word));
        const texts = path.map((p) => [p, read(p)] as const);
        const absent = texts.find(([, text]) => text === undefined);
        if (absent !== undefined) return { exitCode: 1, stderr: `${program}: ${absent[0]}: No such file or directory` };
        const bodies = texts.map(([, text]) => text ?? "");
        if (program === "wc") return { exitCode: 0, stdout: texts.map(([p, text]) => `${(text ?? "").split("\n").length - 1} ${p}`).join("\n") };
        const count = Number(argv.find((word) => /^\d+$/.test(word)) ?? 10);
        if (program === "head") return { exitCode: 0, stdout: bodies.map((text) => text.split("\n").slice(0, count).join("\n")).join("\n") };
        if (program === "tail") return { exitCode: 0, stdout: bodies.map((text) => text.split("\n").slice(-count).join("\n")).join("\n") };
        return { exitCode: 0, stdout: bodies.join("") };
    };
    const list: ExecRule = ({ argv, cwd, list: entries }) => {
        if (argv[0] !== "ls") return undefined;
        const paths = argv.slice(1).filter((word) => !word.startsWith("-"));
        const listed = (paths.length === 0 ? [cwd] : paths).map((path) => [path, entries(path)] as const);
        const absent = listed.find(([, names]) => names === undefined);
        if (absent !== undefined) return { exitCode: 2, stderr: `ls: cannot access '${absent[0]}': No such file or directory` };
        return { exitCode: 0, stdout: listed.map(([path, names]) => (listed.length > 1 ? `${path}:\n` : "") + (names ?? []).join("\n")).join("\n\n") };
    };
    return [lint, runPython, runR, readers, list];
}

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
    for (const [path, text] of Object.entries(files)) {
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
    }
}

function textsUnder(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!existsSync(root)) return out;
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) walk(path);
            else out[relative(root, path)] = readFileSync(path, "utf8").slice(0, 20_000);
        }
    };
    walk(root);
    return out;
}

function lockOf(packages: readonly LockedPackage[]): string {
    return JSON.stringify({
        schema: 1,
        arch: "arm64",
        packages: packages.map((p) => ({
            name: p.name,
            version: p.version,
            track: p.track,
            store_dir: `/store/${p.track}/${p.name}`,
            hash: "0".repeat(64),
            requested: true,
        })),
        languages: { python: { version: "3.12.7", index: "https://pypi.org/simple" }, r: { version: "4.4.2", bioc_releases: ["3.20"] } },
    });
}

/** A pool that never connects. The real tools that hold it run no query outside a durable step. */
function unconnectedPool(): ReturnType<typeof createPool> {
    return createPool({ host: "eval.invalid", port: "5432", database: "eval", user: "eval", password: "eval", sslMode: "disable" });
}

/** The agent of a setup over a fresh tree, for one trial. */
export async function openSandboxTrial(
    setup: SandboxSetup,
    options: { readonly toolOutputStore: ToolOutputStore; readonly label: string },
): Promise<SandboxTrial> {
    mkdirSync(TRIALS_DIR, { recursive: true });
    const dir = mkdtempSync(join(TRIALS_DIR, `${options.label}-`));
    const root = join(dir, ANALYSIS_ID);
    const workingDir = join(root, workingPathOf(setup));
    const profiler = setup.agentId === PROFILER_ID;
    writeTree(root, setup.files);
    mkdirSync(workingDir, { recursive: true });
    const lockFile = join(dir, "env", FARM_LOCK_FILE);
    writeTree(join(dir, "env"), { [FARM_LOCK_FILE]: lockOf(setup.packages) });

    const refsRoot = join(dir, "refs");
    writeTree(refsRoot, setup.refs ?? {});
    const host = (path: string, cwd: string): string | undefined => {
        const absolute = path.startsWith("/") ? path : `${cwd}/${path}`;
        if (absolute === REFS_MOUNT || absolute.startsWith(`${REFS_MOUNT}/`)) return join(refsRoot, absolute.slice(REFS_MOUNT.length));
        if (!absolute.startsWith(`/${ANALYSIS_ID}/`)) return undefined;
        return join(root, absolute.slice(`/${ANALYSIS_ID}/`.length));
    };
    const caseRules = setup.exec ?? [];
    const baseRules = defaultRules(setup.packages);
    const unscripted: string[] = [];
    const answer = (argv: readonly string[], line: string, cwd: string, rules: readonly ExecRule[]): ExecReply | undefined => {
        const view: ExecView = {
            argv,
            line,
            cwd,
            read: (path) => {
                const target = host(path, cwd);
                return target !== undefined && existsSync(target) && statSync(target).isFile() ? readFileSync(target, "utf8") : undefined;
            },
            list: (path) => {
                const target = host(path, cwd);
                return target !== undefined && existsSync(target) && statSync(target).isDirectory() ? readdirSync(target).sort() : undefined;
            },
        };
        for (const rule of rules) {
            const reply = rule(view);
            if (reply !== undefined) return reply;
        }
        return undefined;
    };
    /** Run the simple commands of one exec in order, with the shell builtins that change or report the cwd. */
    const runCommands = (commands: readonly (readonly string[])[], state: { cwd: string }, replies: ExecReply[]): boolean => {
        for (const argv of commands) {
            const program = argv[0] ?? "";
            // A shell inside the line, also as one word, as the model sometimes writes `["sh -c", "..."]`.
            const inner =
                ["sh", "bash"].includes(program) && ["-c", "-lc"].includes(argv[1] ?? "")
                    ? argv.slice(2).join(" ")
                    : ["sh -c", "bash -c", "bash -lc"].includes(program)
                      ? argv.slice(1).join(" ")
                      : undefined;
            if (inner !== undefined) {
                if (!runCommands(shellCommands(inner), state, replies)) return false;
                continue;
            }
            let reply = answer(argv, argv.join(" "), state.cwd, caseRules);
            if (reply !== undefined) {
                // The rule of the case answers first.
            } else if (program === "cd") {
                const target = argv[1] ?? workingDirOf(setup);
                state.cwd = target.startsWith("/") ? target : `${state.cwd}/${target}`;
                reply = { exitCode: 0 };
            } else if (program === "pwd") reply = { exitCode: 0, stdout: state.cwd };
            else if (program === "echo") reply = { exitCode: 0, stdout: argv.slice(1).join(" ") };
            else if (program === "which")
                reply = {
                    exitCode: 0,
                    stdout: argv
                        .slice(1)
                        .map((name) => `/usr/bin/${name}`)
                        .join("\n"),
                };
            else if (program === "mkdir") reply = { exitCode: 0 };
            else {
                reply = answer(argv, argv.join(" "), state.cwd, baseRules);
                if (reply === undefined) {
                    unscripted.push(argv.join(" "));
                    reply = { exitCode: 127, stderr: `${program}: the eval scripts no answer for this command` };
                }
            }
            replies.push(reply);
            writeTree(workingDir, reply.writes ?? {});
            if (reply.exitCode !== 0) return false;
        }
        return true;
    };
    const exec = (_ref: unknown, request: ExecRequest): Promise<ExecResult> => {
        const state = { cwd: request.cwd ?? workingDirOf(setup) };
        // sandbox-server runs a one-element command through `sh -c`. A shell line runs each command of a `;` or `&&`
        // list, and the first command of each pipe, thus a rule answers a simple command.
        const commands = request.command.length === 1 ? shellCommands(request.command[0] ?? "") : [request.command];
        const replies: ExecReply[] = [];
        runCommands(commands, state, replies);
        const last = replies.at(-1) ?? { exitCode: 0 };
        const joined = (pick: (reply: ExecReply) => string | undefined): string =>
            replies
                .map((reply) => pick(reply) ?? "")
                .filter((text) => text.length > 0)
                .join("\n");
        return Promise.resolve({
            execId: "eval:1",
            exitCode: last.exitCode,
            stdout: joined((r) => r.stdout),
            stderr: joined((r) => r.stderr),
            durationMs: 1,
            timedOut: false,
        });
    };

    const deps: SandboxAgentDeps = {
        provider: unusedChatProvider(),
        pool: unconnectedPool(),
        toolchainSource: "image",
        workspaceFs: createWorkspaceFilesystem({ resolveWorkspaceRoot: () => Promise.resolve(root) }),
        model: "eval",
        skillsDir: join(REPO, "skills"),
        farmLockFile: lockFile,
        imagePackagesFile: join(dir, "env", "image-packages.json"),
        extendAnalysisFarm: (_analysisId, queries) =>
            okAsync(
                queries.map((query): PackageRequestOutcome => setup.link?.(query) ?? { kind: "absent", spelling: query.spelling, acquisitionPossible: false }),
            ),
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        // The CLI binds an embedding provider, thus the agent declares `workspace_search`. A case scripts its answer.
        embedding: {
            dimensions: 1536,
            embed: () => {
                throw new Error("an eval embeds nothing");
            },
        },
        // A step reports a blocker and declares its metadata tool. The profiler does neither (`profilerSandboxAgentDeps`).
        reportsBlocker: !profiler,
        fileMetadata: profiler ? undefined : createFileMetadataCell(),
        toolOutputStore: options.toolOutputStore,
        step: {
            // A step acquires its sandbox with `acquire_sandbox`, and the profiler gets its lease before its loop.
            lease: leaseOverClient({ exec }, { sandboxId: "sb-eval", host: "127.0.0.1", port: 8765, backend: "docker" }, { held: profiler }),
            workspaceRoot: root,
            analysisId: ANALYSIS_ID,
            allowedWritePrefix: workingDir,
        },
    };
    const built = createSandboxAgents(deps)[setup.agentId];
    if (built === undefined) throw new Error(`no sandbox agent ${setup.agentId}`);
    let agent = built;
    let seed: string | undefined;
    if (profiler) {
        // The profile body scans the inputs on the host before the agent starts, and it composes the seed from the
        // menu of the scan. The header readout runs in the sandbox, thus a trial has no headers, as when it fails.
        const scan = await scanInputTree({
            session: makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS_ID } }),
            fs: deps.workspaceFs,
            root: "data/inputs",
        });
        const detected = detectSets(scan.files);
        const menu = buildSetMenu(detected, { truncated: scan.manifest.truncated });
        seed = composeProfilerSeed({
            analysisId: ANALYSIS_ID,
            workingDir: workingDirOf(setup),
            resources: { cpu: 2, memoryGb: 8 },
            menu,
            absorb: { kind: "none" },
        });
        agent = { ...built, tools: [...built.tools, createSubmitProfileTool(detected, menu)] };
    }
    return {
        agent,
        seed,
        unscripted,
        files: () => textsUnder(workingDir),
        dispose: () => rmSync(dir, { recursive: true, force: true }),
    };
}
