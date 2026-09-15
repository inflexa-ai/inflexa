/**
 * The derivation tool of a report session.
 *
 * A run writes statistical tables, and not plot-ready ones. This tool reshapes the pinned evidence into one
 * table that a block can bind: a join, a pivot, or an aggregate. The agent writes the script, and the record
 * chains the derived table back to the evidence that made it.
 *
 * A session derivation is not an analysis run. It mints no run id, it registers no artifact, and it writes
 * under the session directory alone. The rails are the rails of the value tier (`tasks/extract-values.ts`):
 * the injected exec runner, the identity mint, and the authorizer on every terminal path. The container is
 * ephemeral, and it goes away with the work.
 *
 * The container mounts the analysis tree read-only, and one write mount covers the `derived/` directory of
 * the session alone. The script writes its table into that mount directly, thus a large table makes no
 * roundtrip and no write of the script can reach the workspace tree. The working directory of the exec is
 * that same mount, and the standard output carries the logs of the script alone.
 *
 * The host then reads the file that the container wrote. A path inside the mount is still untrusted bytes: a
 * script can leave a symbolic link in place of its output. Thus the host classifies the file against the
 * workspace root before it hashes one byte, and an escape refuses as typed data.
 *
 * Each declared input must sit in the served membership, and its hash comes from there. The declaration is
 * what the record pins, thus a derived cell traces to a pinned artifact and to the script that read it.
 *
 * The tool refuses an output name that the membership already holds. A record is immutable, and a second
 * derivation of one table takes a new name.
 *
 * A composition with no sandbox client and no run authorizer cannot derive at all. The tool reports that
 * condition one time, up front, the same discipline as the eyes. A per-attempt failure would instead read as
 * a transient fault, and it would invite a repeat of a call that can never pass.
 *
 * The container runs behind a seam, and never in the turn. An await of an exec is a workflow-body call
 * under the callback transport, and a report turn is not a body. Thus the tool takes an injected runner,
 * and a registered workflow owns the container. The tool holds no sandbox client, and it imports no DBOS.
 */

import { ok, type Result } from "neverthrow";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { RunAuthorization, RunAuthorizer } from "../../execution/run-authorizer.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import { classifyWithinRoot, computeSha256, computeSha256File } from "../../lib/fs-helpers.js";
import { defaultErrorFields, type Logger } from "../../lib/logger.js";
import type { ResourceSpec } from "../../config/resource-limits.js";
import { snapshotEntry } from "../../report-model/reference-resolver.js";
import { generateExecutionId } from "../../sandbox/execution-id.js";
import type { ExecResult, SubmitExecBody } from "../../sandbox/types.js";
import type { DerivationRecord, DerivationSource, ReportSessionStateStore } from "../../state/report-session-state.js";
import { isSafeId, reportSessionDerivedDir, toSandboxPath, type ResolveWorkspaceRoot } from "../../workspace/paths.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import { openReportThread, type ReportSessionStateGateway, type SessionRefusal } from "../report-authoring/authoring-tools.js";
import { bindSessionEmit, type ProvenanceSeam } from "../../provenance/seam.js";
import { readHeaderColumns } from "./list-artifacts.js";

/** The input of one derivation: the script, the declared pinned inputs, and the name of the output file. */
const deriveTableInput = z.object({
    script: z.string().min(1),
    inputs: z.array(z.string()).min(1),
    output: z.string().min(1),
});

export type DeriveTableInput = z.infer<typeof deriveTableInput>;

/**
 * The typed outcome of the derivation tool. Each arm is ok-channel data, thus the tool never throws for one
 * of them.
 *
 * `derived` carries the workspace-relative path of the derived table, its content hash, the hash of the
 * script, the sources that the record pins, and the header columns of the output. Each other arm names a
 * condition that the agent repairs: a call that is out of bounds, an input that the membership does not
 * hold, a name that a record already holds, a script that failed in the container, and a green script that
 * left no file at the output name.
 */
export type DeriveTableResult =
    | { outcome: "refused"; refusal: SessionRefusal }
    | { outcome: "unavailable"; detail: string }
    | { outcome: "script-too-large"; bytes: number; cap: number; detail: string }
    | { outcome: "too-many-inputs"; count: number; cap: number; detail: string }
    | { outcome: "unsafe-name"; detail: string }
    | { outcome: "absent-input"; path: string; detail: string }
    | { outcome: "repeated-name"; outputPath: string; detail: string }
    | { outcome: "exec-failed"; detail: string }
    | { outcome: "no-output"; detail: string }
    | { outcome: "derived"; path: string; hash: string; scriptHash: string; sources: DerivationSource[]; columns?: string[] };

/**
 * The construction deps of the derivation tool.
 *
 * `derivations` is the append side of the durable session state, thus the record lands beside the document
 * and the pin. `sandboxClient` and `runAuthorizer` are the two rails of the exec, and a composition that
 * binds neither leaves the session with no derivation at all. `resolveWorkspaceRoot` maps the analysis of
 * the call onto its workspace root, thus one singleton tool serves every analysis.
 */
export interface DeriveTableToolDeps {
    readonly gateway: ReportSessionStateGateway;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly derivations: Pick<ReportSessionStateStore, "appendDerivation">;
    readonly runDerivation?: DeriveTableRunner;
    readonly runAuthorizer?: RunAuthorizer;
    /** The provenance seam; an unbound session emit emits nothing and the derivation runs the same. */
    readonly provenance?: ProvenanceSeam;
    readonly logger?: Logger;
}

/** The synthetic run id and step id of one derivation. Both are constants, and neither names a run row. */
export const DERIVE_RUN_LITERAL = "derive-table" as const;
export const DERIVE_STEP_LITERAL = "derive" as const;

/** The provenance agent id. No agent loop runs in the container, thus this names the derivation pass. */
const DERIVE_AGENT_ID = "table-deriver" as const;

/** The exec budget of one derivation. It matches the budget of the value tier. */
export const DERIVATION_DEADLINE_MS = 300_000;

/**
 * The container size of one derivation. A join or a pivot loads each declared input into pandas at one
 * time, thus the container needs the headroom of the value tier.
 */
export const DERIVATION_RESOURCES: ResourceSpec = { cpu: 2, memoryGb: 8 };

/** The cap of the script, in bytes. A reshaping script sits far under it, and the command line carries it. */
const SCRIPT_CAP_BYTES = 64 * 1024;

/** The cap of the declared inputs. One derivation reads the evidence of a few artifacts, and never a tree. */
const INPUT_CAP = 20;

/** The environment variable that carries the declared inputs into the container. */
export const DERIVE_INPUT_ENV = "DERIVE_INPUTS";

/** The environment variable that carries the container path of the output file into the container. */
export const DERIVE_OUTPUT_ENV = "DERIVE_OUTPUT";

/** The cap of the failure detail that the tool copies out of the standard error of the script. */
const STDERR_TAIL_CAP = 2_000;

/** The line that the agent reads when the composition binds no sandbox rails. */
const NO_SANDBOX_DETAIL = "the composition gives no sandbox, thus this session cannot derive a table";

/** One declared input, as the container reads it: the mounted path of the file, and its pinned hash. */
export interface DerivationInputMount {
    readonly path: string;
    readonly hash: string;
}

/**
 * Build the sandbox exec of one derivation. The command runs the script of the agent through `python3 -c`.
 *
 * The working directory is the write mount, thus the script writes its table beside where it stands. Each
 * declared input rides as its mounted path, thus the script opens the file wherever it works from. The
 * output path rides too, thus the script names no directory of its own.
 *
 * The function is pure, thus a test asserts the command shape without a sandbox.
 */
export function buildDerivationExec(args: {
    readonly script: string;
    readonly execId: string;
    readonly workingDir: string;
    readonly inputs: readonly DerivationInputMount[];
    readonly output: string;
}): SubmitExecBody {
    return {
        command: ["python3", "-c", args.script],
        execId: args.execId,
        cwd: args.workingDir,
        env: {
            [DERIVE_INPUT_ENV]: JSON.stringify(args.inputs.map((input) => ({ path: input.path, hash: input.hash }))),
            [DERIVE_OUTPUT_ENV]: args.output,
        },
        timeoutSeconds: Math.floor(DERIVATION_DEADLINE_MS / 1000),
    };
}

/**
 * Give the failure of an exec result, or `undefined` when the script ran to a clean exit.
 *
 * A synthetic failure, a timeout, and a non-zero exit each mean that no table came back. The detail of a
 * non-zero exit carries the tail of the standard error, thus the agent repairs the script from what the
 * container reported.
 *
 * The function is pure, thus a test asserts the mapping without a sandbox.
 */
export function describeExecFailure(result: ExecResult): string | undefined {
    if (result.syntheticFailure !== undefined) {
        return `the derivation sandbox failed: ${result.syntheticFailure.reason}`;
    }
    if (result.timedOut) {
        return "the derivation reached the deadline";
    }
    if (result.exitCode !== 0) {
        const tail = result.stderr.slice(-STDERR_TAIL_CAP).trim();
        const exit = `the script exited with code ${String(result.exitCode)}`;
        return tail.length === 0 ? exit : `${exit}: ${tail}`;
    }
    return undefined;
}

/**
 * The exec of one derivation, as a registered workflow reads it.
 *
 * Each field is plain data, thus the value crosses the workflow boundary and it survives a replay. The
 * paths are container paths already: the host maps them one time, before the start.
 */
export interface DeriveTableExecInput {
    readonly analysisId: string;
    readonly executionId: string;
    readonly script: string;
    readonly writableTail: string;
    readonly workingDir: string;
    readonly inputs: readonly DerivationInputMount[];
    readonly output: string;
}

/**
 * Run one derivation exec and give the terminal result back.
 *
 * The composition realizes it over a registered workflow, thus the container lives inside a workflow body
 * and the await is legal under each transport. A fault of the sandbox rejects the promise, and the tool
 * turns that rejection into one short detail.
 */
export type DeriveTableRunner = (input: DeriveTableExecInput) => Promise<ExecResult>;

/**
 * Make the derivation tool over the session-state gateway, the derivation ledger, and the sandbox rails.
 *
 * The tool reads the thread id from the scope of the call, and it loads the membership through the gateway.
 * Thus one factory serves every thread, and the tool holds no per-session value.
 */
export function createDeriveTableTool(deps: DeriveTableToolDeps): Tool<DeriveTableInput, DeriveTableResult> {
    const logger = (deps.logger ?? createNoopLogger()).named("derive-table");
    const observe = bindSessionEmit(deps.provenance, logger);
    const { runDerivation, runAuthorizer } = deps;

    return defineTool({
        id: "derive_table",
        description:
            "Derive one table from the pinned evidence with a Python script, and pin the result to this session. " +
            "Reach for it when a real reshaping stands between the evidence and the block: a join of two tables, a pivot, or an aggregate. " +
            "A per-row transform is not a derivation, because a chart block reads the column that it needs. " +
            "Name each pinned path that the script reads in `inputs`: each one must sit in the pinned evidence, and the record pins its hash. " +
            'Give the file name of the result in "output": one name, with no directory and no separator, for example "yield_by_group.csv". ' +
            `The script reads the ${DERIVE_INPUT_ENV} environment variable for its inputs: a JSON list that gives the mounted path and the hash of each declared one. ` +
            `It writes the whole table as CSV to the path in the ${DERIVE_OUTPUT_ENV} environment variable, which sits in the working directory of the script. ` +
            "That directory is the one place that the script can write: the analysis mounts read-only, and the container has no network. " +
            "The standard output carries the logs of the script alone, thus a table that it prints there reaches nobody. " +
            "The derived table joins the pinned evidence of this session, thus a block binds its path the same way as a pinned artifact. " +
            "A name that this session already derived is refused, thus a second derivation of one table takes a new name.",
        inputSchema: deriveTableInput,
        executionMode: "inline",
        describeCall: (input): string => `derive ${input.output}`,
        // The derived path is the one durable product of the call, thus the derived arm names it. Each other
        // arm is a condition that refused, and the kind of the arm is what a watcher must read.
        describeResult: (_input, result): string => (result.outcome === "derived" ? result.path : result.outcome),
        execute: async (input, ctx): Promise<Result<DeriveTableResult, ToolError>> => {
            // The check runs before every read, thus one clear signal replaces a failure for each attempt.
            // It also narrows the two rails below, thus the exec needs no assertion.
            if (runDerivation === undefined || runAuthorizer === undefined) {
                logger.warn("the composition gives no sandbox, thus no derivation can run");
                return ok({ outcome: "unavailable", detail: NO_SANDBOX_DETAIL });
            }

            const opened = await openReportThread(deps.gateway, ctx.session.scope);
            if (opened.isErr()) {
                return ok({ outcome: "refused", refusal: opened.error });
            }
            const { threadId, analysisId, state } = opened.value;

            const bytes = Buffer.byteLength(input.script, "utf8");
            if (bytes > SCRIPT_CAP_BYTES) {
                return ok({
                    outcome: "script-too-large",
                    bytes,
                    cap: SCRIPT_CAP_BYTES,
                    detail: `the script is ${String(bytes)} bytes, and the cap is ${String(SCRIPT_CAP_BYTES)} bytes`,
                });
            }
            // A repeated path names one source, thus the list keeps the first occurrence and the record pins
            // each source one time.
            const declared = [...new Set(input.inputs)];
            if (declared.length > INPUT_CAP) {
                return ok({
                    outcome: "too-many-inputs",
                    count: declared.length,
                    cap: INPUT_CAP,
                    detail: `the call declares ${String(declared.length)} inputs, and the cap is ${String(INPUT_CAP)}`,
                });
            }
            if (!isSafeId(input.output)) {
                return ok({
                    outcome: "unsafe-name",
                    detail: "the output names one file, with no directory, no separator, and no traversal",
                });
            }

            // Each declared input takes its hash from the served membership. A path that the membership does
            // not hold has no pinned hash, thus the record could chain nothing to it.
            const sources: DerivationSource[] = [];
            for (const path of declared) {
                const entry = snapshotEntry(state.snapshot, path);
                if (entry === undefined) {
                    return ok({
                        outcome: "absent-input",
                        path,
                        detail: `the pinned evidence of this session holds no artifact at ${path}`,
                    });
                }
                sources.push({ path, hash: entry.hash });
            }

            // The write tail is the one writable mount of the container, and the output sits inside it. Both
            // compose from the session-directory builder, thus the layout has one owner.
            const writableTail = reportSessionDerivedDir(threadId);
            const outputPath = `${writableTail}/${input.output}`;
            // The served membership carries each derivation of the session, thus this one test refuses a
            // repeated name and a collision with a pinned artifact alike.
            if (snapshotEntry(state.snapshot, outputPath) !== undefined) {
                return ok({
                    outcome: "repeated-name",
                    outputPath,
                    detail: `the evidence of this session already holds ${outputPath}, thus this derivation takes a new name`,
                });
            }

            let root: string;
            try {
                root = deps.resolveWorkspaceRoot(analysisId);
            } catch (cause) {
                logger.warn("the workspace root did not resolve", { threadId, analysisId, ...defaultErrorFields(cause) });
                return ok({ outcome: "unavailable", detail: "the workspace root did not resolve, thus the derived table has no place to land" });
            }

            let authorization: RunAuthorization;
            try {
                authorization = await runAuthorizer.authorize({
                    auth: ctx.session.auth,
                    scope: { kind: "analysis", analysisId },
                    provenance: { agentId: DERIVE_AGENT_ID, callPath: [DERIVE_AGENT_ID] },
                    frame: { runId: DERIVE_RUN_LITERAL, stepId: DERIVE_STEP_LITERAL },
                });
            } catch (cause) {
                logger.error("the derivation was not authorized", { threadId, analysisId, ...defaultErrorFields(cause) });
                return ok({ outcome: "unavailable", detail: "the derivation was not authorized" });
            }

            // The work sits inside the `try`, and the revoke sits in the `finally`. Thus the authorization
            // revokes on every terminal path, the thrown one included: a path builder refuses a hostile
            // stored path with a throw, and that throw must not leave an authorization standing.
            let result: DeriveTableResult | undefined;
            try {
                result = await derive({
                    runDerivation,
                    derivations: deps.derivations,
                    root,
                    threadId,
                    analysisId,
                    script: input.script,
                    sources,
                    writableTail,
                    outputPath,
                    outputName: input.output,
                    logger,
                });
                // The record of the derivation lands before this point, thus the event states a table that
                // the session already holds as evidence. Each other arm derived nothing.
                if (result.outcome === "derived") {
                    observe({
                        type: "run-derivation",
                        analysisId,
                        threadId,
                        outputPath: result.path,
                        outputHash: result.hash,
                        scriptHash: result.scriptHash,
                        sources: result.sources,
                    });
                }
                return ok(result);
            } finally {
                // A revoke fault changes no outcome of the call, thus it reaches the log alone. An absent
                // result means that the work threw, and a throw is a failed derivation.
                try {
                    await runAuthorizer.revoke(authorization, result?.outcome === "derived" ? "derive-table-completed" : "derive-table-failed");
                } catch (cause) {
                    logger.warn("the derivation authorization did not revoke", { threadId, analysisId, ...defaultErrorFields(cause) });
                }
            }
        },
    });
}

/**
 * Run one derivation and record what the script wrote.
 *
 * The order is the order of the evidence. The script writes into the write mount, the host classifies the
 * file, the hash comes off the disk, and the record lands last. Thus the recorded hash is the hash of the
 * file that a verifier reads.
 *
 * The classification is the guard of the read. A script can leave a symbolic link at the output name, and a
 * link that resolves outside the tree would otherwise carry a host file into the evidence of the session.
 *
 * The output path clears before the exec. The host owns the `derived/` directory, and a failed attempt can
 * leave a file at the name that this attempt declares. Without the clearance a script that writes nothing
 * would adopt those bytes as its own table, and the record would chain a script to a file that it never
 * wrote. A clearance fault refuses the derivation, because the same doubt stands.
 */
async function derive(args: {
    readonly runDerivation: DeriveTableRunner;
    readonly derivations: Pick<ReportSessionStateStore, "appendDerivation">;
    readonly root: string;
    readonly threadId: string;
    readonly analysisId: string;
    readonly script: string;
    readonly sources: readonly DerivationSource[];
    readonly writableTail: string;
    readonly outputPath: string;
    readonly outputName: string;
    readonly logger: Logger;
}): Promise<DeriveTableResult> {
    const executionId = generateExecutionId(DERIVE_AGENT_ID);
    const absolute = join(args.root, args.outputPath);
    // The container sees the tree at its own mount point, thus each path that the script reads maps through
    // the one host-to-container mapper and never through a formula here.
    const workingDir = toSandboxPath(args.root, args.analysisId, join(args.root, args.writableTail));

    // `unlink` removes a symbolic link as the link, and never the file that it names. An absent path is the
    // normal condition, thus it is not a fault.
    try {
        await unlink(absolute);
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
            args.logger.error("the output path did not clear before the derivation", { threadId: args.threadId, ...defaultErrorFields(cause) });
            return { outcome: "exec-failed", detail: `${args.outputName} already holds a file that did not clear, thus this derivation takes a new name` };
        }
    }

    // The path mapper refuses a stored path that escapes the root, with a throw. It runs before the try,
    // thus that refusal stays a throw and it never reads as a fault of the container.
    const execInput: DeriveTableExecInput = {
        analysisId: args.analysisId,
        executionId,
        script: args.script,
        writableTail: args.writableTail,
        workingDir,
        inputs: args.sources.map((source) => ({ path: toSandboxPath(args.root, args.analysisId, join(args.root, source.path)), hash: source.hash })),
        output: toSandboxPath(args.root, args.analysisId, absolute),
    };

    let executed: ExecResult;
    try {
        executed = await args.runDerivation(execInput);
    } catch (cause) {
        args.logger.error("the derivation exec did not complete", { threadId: args.threadId, ...defaultErrorFields(cause) });
        return { outcome: "exec-failed", detail: "the derivation exec did not complete" };
    }
    const failure = describeExecFailure(executed);
    if (failure !== undefined) {
        return { outcome: "exec-failed", detail: failure };
    }

    const verdict = await classifyWithinRoot(args.root, absolute).catch((cause: unknown) => {
        args.logger.error("the derived table did not classify", { threadId: args.threadId, ...defaultErrorFields(cause) });
        return "escaped" as const;
    });
    if (verdict === "absent") {
        // A clean exit with no file at the output path means that the script wrote nothing, or that it wrote
        // under a different name inside the mount. Either way this derivation has no table.
        return {
            outcome: "no-output",
            detail: `the script ran to a clean exit and it wrote no file at ${args.outputName}`,
        };
    }
    if (verdict === "escaped") {
        args.logger.error("the derived table resolves outside the workspace root", { threadId: args.threadId, path: args.outputPath });
        return { outcome: "exec-failed", detail: `${args.outputName} resolves outside the workspace tree, thus it is not evidence of this session` };
    }

    let outputHash: string;
    try {
        outputHash = await computeSha256File(absolute);
    } catch (cause) {
        args.logger.error("the derived table did not hash", { threadId: args.threadId, ...defaultErrorFields(cause) });
        return { outcome: "exec-failed", detail: "the derived table did not hash" };
    }

    const record: DerivationRecord = {
        outputPath: args.outputPath,
        outputHash,
        sources: [...args.sources],
        scriptHash: computeSha256(Buffer.from(args.script, "utf8")),
        script: args.script,
    };
    const appended = await args.derivations.appendDerivation(args.threadId, record);
    if (appended.isErr()) {
        args.logger.error("the derivation record did not land", { threadId: args.threadId, ...args.logger.errorFields(appended.error.cause) });
        return { outcome: "exec-failed", detail: "the derivation record did not land, thus the table is not evidence of this session" };
    }
    if (appended.value === "duplicate") {
        // The membership test above already refused a repeated name. A duplicate here means that another
        // turn landed the same name inside this call, thus the name rule of the store is the last word.
        return {
            outcome: "repeated-name",
            outputPath: args.outputPath,
            detail: `another turn recorded ${args.outputPath} first, thus this derivation takes a new name`,
        };
    }
    if (appended.value === "absent") {
        args.logger.error("the derivation record matched no session row", { threadId: args.threadId });
        return { outcome: "exec-failed", detail: "no report session state row exists to hold the derivation" };
    }

    // The columns describe the derived table the same way as the listing describes a pinned one. A file that
    // gives no header gives no columns, and absence is a normal condition here.
    const columns = await readColumnsQuietly(args.outputPath, absolute, args.logger);
    return {
        outcome: "derived",
        path: args.outputPath,
        hash: outputHash,
        scriptHash: record.scriptHash,
        sources: [...args.sources],
        ...(columns === undefined ? {} : { columns }),
    };
}

/**
 * The header columns of the derived table, or `undefined` when the read gives none.
 *
 * The derivation already landed at this point, thus a read fault costs the columns alone. The read never
 * throws for an absent file, and this guard covers a genuine fault of the disk.
 */
async function readColumnsQuietly(path: string, absolute: string, logger: Logger): Promise<string[] | undefined> {
    try {
        return await readHeaderColumns(path, absolute);
    } catch (cause) {
        logger.warn("the derived table gave no columns", { path, ...defaultErrorFields(cause) });
        return undefined;
    }
}
