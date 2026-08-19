/**
 * The tests of the derivation tool.
 *
 * Each test drives the tool through `execute` with a temp directory as the workspace root, an in-memory
 * gateway, an in-memory derivation ledger, and a stubbed sandbox client. The stub gives back the exec result
 * that the case names, and it writes into the host side of the write mount the way a script would. Thus no
 * container runs and each arm of the tool is decidable here.
 *
 * The cases cover the happy path, the declared write tail, the undeclared input, the repeated name, the
 * over-cap script, the input cap, the unsafe name, the failed exec, the green exec that wrote no file, the
 * output that resolves outside the tree, and the composition that binds no sandbox.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Scope } from "../../auth/types.js";
import { createLocalRunAuthorizer } from "../../auth/local-run-authorizer.js";
import type { RunAuthorization, RunAuthorizer } from "../../execution/run-authorizer.js";
import type { DbError } from "../../lib/db-result.js";
import { computeSha256 } from "../../lib/fs-helpers.js";
import type { ReportSnapshot } from "../../report-model/reference-resolver.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { CreateSandboxMeta, ExecResult, SandboxRef, SubmitExecBody } from "../../sandbox/types.js";
import { runDeriveTableExecBody } from "../../tasks/derive-table-exec.js";
import { workflowIdFromExec } from "../../sandbox/exec-id.js";
import type { AppendDerivationOutcome, DerivationRecord } from "../../state/report-session-state.js";
import { reportSessionDir } from "../../workspace/paths.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ToolContext } from "../define-tool.js";
import type { ReportSessionState, ReportSessionStateGateway, SessionStateLoad, SessionStatePersist, StampResult } from "../report-authoring/authoring-tools.js";
import {
    buildDerivationExec,
    createDeriveTableTool,
    describeExecFailure,
    DERIVE_INPUT_ENV,
    DERIVE_OUTPUT_ENV,
    type DeriveTableResult,
} from "./derive-table.js";

/** Each root that a test made. The cleanup removes them after the suite. */
const roots: string[] = [];

afterAll(async () => {
    for (const root of roots) {
        await rm(root, { recursive: true, force: true });
    }
});

async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "derive-table-"));
    roots.push(root);
    return root;
}

/** The default analysis of a seeded thread. It matches the scope of `ctxForThread`, thus a call resolves. */
const DEFAULT_ANALYSIS_ID = "analysis-001";

/** The pinned path that most cases declare, and its pinned hash. */
const PINNED_PATH = "runs/r1/output/de.csv";
const PINNED_HASH = "sha256:aaa111";

/** A short reshaping script. The stub never runs it, thus its body only has to be a plausible one. */
const SCRIPT = 'import os, pandas as pd\npd.read_csv("de.csv").to_csv(os.environ["DERIVE_OUTPUT"], index=False)\n';

/** The table that the stub writes into the write mount for a green exec. */
const TABLE = "group,yield\na,3\nb,5\n";

const emptyDraft = { title: "", sections: [] };

/** An in-memory gateway. It holds one state and one analysis for each thread. */
interface FakeGateway extends ReportSessionStateGateway {
    seed(threadId: string, snapshot: ReportSnapshot): void;
}

function makeFakeGateway(): FakeGateway {
    const rows = new Map<string, ReportSessionState>();
    return {
        seed(threadId, snapshot): void {
            rows.set(threadId, { document: structuredClone(emptyDraft), snapshot: structuredClone(snapshot) });
        },
        load(threadId): Promise<SessionStateLoad> {
            const state = rows.get(threadId);
            if (state === undefined) {
                return Promise.resolve({ outcome: "absent" });
            }
            const copy = structuredClone(state);
            return Promise.resolve({
                outcome: "found",
                state: copy,
                analysisId: DEFAULT_ANALYSIS_ID,
                token: copy.document,
                seenDocumentHash: null,
                derivations: [],
            });
        },
        persist(): Promise<SessionStatePersist> {
            return Promise.resolve({ outcome: "persisted" });
        },
        stampRendered(): Promise<StampResult> {
            return Promise.resolve({ outcome: "stamped" });
        },
        stampSeen(): Promise<StampResult> {
            return Promise.resolve({ outcome: "stamped" });
        },
    };
}

/** An in-memory derivation ledger with the name rule of the store. */
interface FakeLedger {
    appendDerivation(threadId: string, record: DerivationRecord): ResultAsync<AppendDerivationOutcome, DbError>;
    readonly records: DerivationRecord[];
}

function makeLedger(outcome?: AppendDerivationOutcome, fault?: DbError): FakeLedger {
    const records: DerivationRecord[] = [];
    return {
        records,
        appendDerivation(_threadId, record): ResultAsync<AppendDerivationOutcome, DbError> {
            if (fault !== undefined) {
                return errAsync(fault);
            }
            if (outcome !== undefined) {
                return okAsync(outcome);
            }
            if (records.some((held) => held.outputPath === record.outputPath)) {
                return okAsync("duplicate");
            }
            records.push(record);
            return okAsync("appended");
        },
    };
}

/** A stubbed sandbox client. It records what the tool asked for, and it gives back one exec result. */
interface FakeSandbox {
    readonly client: SandboxClient;
    readonly creates: CreateSandboxMeta[];
    readonly submits: SubmitExecBody[];
    readonly teardowns: string[];
}

/**
 * The host side of a container path. The tree mounts at `/{analysisId}`, thus the stub strips that mount
 * point and joins the tail onto the root. The stub writes where the container would write, and the tool then
 * reads the file exactly as it reads a real one.
 */
function hostSideOf(root: string, containerPath: string): string {
    return join(root, containerPath.slice(`/${DEFAULT_ANALYSIS_ID}/`.length));
}

/**
 * A stubbed sandbox client.
 *
 * `write` stands for the script: it runs at the moment the exec settles, and it gets the host side of the
 * output path that the submit body declared. A case that gives none models a script that wrote no file.
 */
function makeSandbox(args: {
    readonly root: string;
    readonly reply?: ExecResult;
    readonly throws?: boolean;
    readonly write?: (outputHostPath: string) => Promise<void>;
}): FakeSandbox {
    const creates: CreateSandboxMeta[] = [];
    const submits: SubmitExecBody[] = [];
    const teardowns: string[] = [];
    const ref: SandboxRef = { sandboxId: "sbx-derive-1", host: "127.0.0.1", port: 8765, backend: "docker", callbackSecret: "base64:secret" };
    const client = {
        createSandbox(meta: CreateSandboxMeta): Promise<SandboxRef> {
            creates.push(meta);
            return Promise.resolve(ref);
        },
        submitExec(_ref: SandboxRef, body: SubmitExecBody): Promise<void> {
            submits.push(body);
            return Promise.resolve();
        },
        async awaitExec(): Promise<ExecResult> {
            if (args.throws === true) {
                throw new Error("the poll loop broke");
            }
            const body = submits[submits.length - 1];
            if (args.write !== undefined && body !== undefined) {
                await args.write(hostSideOf(args.root, body.env![DERIVE_OUTPUT_ENV]));
            }
            return args.reply ?? execResult({});
        },
        teardown(handle: SandboxRef): Promise<void> {
            teardowns.push(handle.sandboxId);
            return Promise.resolve();
        },
        isAlive: () => Promise.resolve({ alive: true, oomKilled: false }),
        teardownById: () => Promise.resolve(),
        listManagedSandboxes: () => Promise.resolve([]),
    } satisfies SandboxClient;
    return { client, creates, submits, teardowns };
}

/** The write of a script that lands the table at the declared output path. */
function writesTable(table = TABLE): (outputHostPath: string) => Promise<void> {
    return async (outputHostPath) => {
        await mkdir(dirname(outputHostPath), { recursive: true });
        await writeFile(outputHostPath, table, "utf8");
    };
}

/** A run authorizer over the local realization, with the revoke reasons recorded. */
interface FakeAuthorizer {
    readonly authorizer: RunAuthorizer;
    readonly frames: string[];
    readonly revoked: string[];
}

function makeAuthorizer(): FakeAuthorizer {
    const local = createLocalRunAuthorizer();
    const frames: string[] = [];
    const revoked: string[] = [];
    const authorizer: RunAuthorizer = {
        async authorize(input): Promise<RunAuthorization> {
            frames.push(`${input.frame.runId}/${input.frame.stepId}/${input.provenance.agentId}`);
            return local.authorize(input);
        },
        async revoke(_authorization, reason): Promise<void> {
            revoked.push(reason);
        },
        async revokeByJti(): Promise<void> {},
    };
    return { authorizer, frames, revoked };
}

/** A complete exec result. Each case overrides only the fields that it asserts. */
function execResult(over: Partial<ExecResult>): ExecResult {
    return { execId: "exec-1", exitCode: 0, stdout: TABLE, stderr: "", durationMs: 12, timedOut: false, ...over };
}

/** A tool context whose scope names a report thread. */
function ctxForThread(threadId: string): ToolContext {
    const { ctx } = makeToolContext();
    const scope: Scope = { kind: "analysis", analysisId: DEFAULT_ANALYSIS_ID, threadId };
    return { ...ctx, session: { ...ctx.session, scope } };
}

/** The snapshot that pins one tabular output. */
function pinnedSnapshot(): ReportSnapshot {
    return { artifacts: { [PINNED_PATH]: { hash: PINNED_HASH, fileType: "output" } } };
}

/** One assembled tool over the four seams, with each recording part handed back. */
function makeTool(args: { root: string; snapshot?: ReportSnapshot; result?: ExecResult; ledger?: FakeLedger; sandbox?: FakeSandbox }) {
    const gateway = makeFakeGateway();
    gateway.seed("t1", args.snapshot ?? pinnedSnapshot());
    // The default stub is a script that lands the table where the submit body declared it.
    const sandbox = args.sandbox ?? makeSandbox({ root: args.root, ...(args.result ? { reply: args.result } : {}), write: writesTable() });
    const ledger = args.ledger ?? makeLedger();
    const auth = makeAuthorizer();
    const tool = createDeriveTableTool({
        gateway,
        resolveWorkspaceRoot: () => args.root,
        derivations: ledger,
        // The composition realizes the runner over a registered workflow. The test drives the same body,
        // with a fixed clock, thus the seam calls under test are the seam calls in production.
        runDerivation: (input) => runDeriveTableExecBody(input, { sandboxClient: sandbox.client, now: () => Promise.resolve(0) }),
        runAuthorizer: auth.authorizer,
    });
    return { tool, gateway, sandbox, ledger, auth };
}

/** Run the tool over one thread, and give back the ok value. */
async function derive(tool: ReturnType<typeof makeTool>["tool"], input: { script?: string; inputs?: string[]; output?: string }): Promise<DeriveTableResult> {
    return (
        await tool.execute({ script: input.script ?? SCRIPT, inputs: input.inputs ?? [PINNED_PATH], output: input.output ?? "yield.csv" }, ctxForThread("t1"))
    )._unsafeUnwrap();
}

describe("the derived table", () => {
    it("lands under the derived directory of the session, and the record pins the chain", async () => {
        const root = await makeRoot();
        const { tool, sandbox, ledger, auth } = makeTool({ root });

        const result = await derive(tool, {});

        expect(result.outcome).toBe("derived");
        if (result.outcome !== "derived") throw new Error("expected a derived table");
        // The derived path sits under the directory of the session, thus the disposal of that directory
        // removes the derived table with it.
        expect(result.path).toBe(`${reportSessionDir("t1")}/derived/yield.csv`);
        expect(result.path.startsWith(`${reportSessionDir("t1")}/`)).toBe(true);
        // The bytes that the script wrote into the mount are the bytes of the derived table.
        expect(await readFile(join(root, result.path), "utf8")).toBe(TABLE);
        // The hash comes off the disk, thus it is the hash that a verifier reads.
        expect(result.hash).toBe(computeSha256(Buffer.from(TABLE, "utf8")));
        expect(result.scriptHash).toBe(computeSha256(Buffer.from(SCRIPT, "utf8")));
        // The columns describe the derived table, the same way the listing describes a pinned one.
        expect(result.columns).toEqual(["group", "yield"]);
        // The source carries the hash of the served membership, and never a hash of the call.
        expect(result.sources).toEqual([{ path: PINNED_PATH, hash: PINNED_HASH }]);

        // The record holds what a second run needs: the script, the sources, and the output hash.
        expect(ledger.records).toHaveLength(1);
        expect(ledger.records[0]).toEqual({
            outputPath: result.path,
            outputHash: result.hash,
            sources: [{ path: PINNED_PATH, hash: PINNED_HASH }],
            scriptHash: result.scriptHash,
            script: SCRIPT,
        });

        // The container is ephemeral, thus it goes away with the work.
        expect(sandbox.teardowns).toEqual(["sbx-derive-1"]);
        // The authorization revokes on the terminal path.
        expect(auth.revoked).toEqual(["derive-table-completed"]);
    });

    it("declares the derived directory as the one write mount of the container", async () => {
        const root = await makeRoot();
        const { tool, sandbox, auth } = makeTool({ root });

        await derive(tool, {});

        expect(sandbox.creates).toHaveLength(1);
        const meta = sandbox.creates[0]!;
        // The one writable mount of the container is the derived directory of this session. The tree stays
        // read-only under it, thus no write of the script can reach the analysis.
        expect(meta.writableTail).toBe(`${reportSessionDir("t1")}/derived`);
        // A read-only container could write nothing at all, thus the two are never declared together.
        expect(meta.readOnly).toBeUndefined();
        expect(meta.analysisId).toBe(DEFAULT_ANALYSIS_ID);
        // The run id and the step id are constants of the derivation. Neither one names a run of the
        // analysis, thus the pass mints no run.
        expect(meta.runId).toBe("derive-table");
        expect(meta.stepId).toBe("derive");
        expect(meta.resources).toEqual({ cpu: 2, memoryGb: 8 });
        // The frame of the authorization names the same synthetic run.
        expect(auth.frames).toEqual(["derive-table/derive/table-deriver"]);
    });

    it("submits the script with the mounted inputs and the mounted output path", async () => {
        const root = await makeRoot();
        const { tool, sandbox } = makeTool({ root });

        await derive(tool, {});

        expect(sandbox.submits).toHaveLength(1);
        const body = sandbox.submits[0]!;
        expect(body.command).toEqual(["python3", "-c", SCRIPT]);
        // The working directory is the write mount, thus the script writes beside where it stands.
        expect(body.cwd).toBe(`/${DEFAULT_ANALYSIS_ID}/${reportSessionDir("t1")}/derived`);
        // Each declared input rides as the path that the container reads, with the hash of the membership.
        expect(JSON.parse(body.env![DERIVE_INPUT_ENV])).toEqual([{ path: `/${DEFAULT_ANALYSIS_ID}/${PINNED_PATH}`, hash: PINNED_HASH }]);
        // The output path rides too, thus the script names no directory of its own.
        expect(body.env![DERIVE_OUTPUT_ENV]).toBe(`/${DEFAULT_ANALYSIS_ID}/${reportSessionDir("t1")}/derived/yield.csv`);
    });

    it("gives the derived path as the result line, and the output name as the call line", async () => {
        const root = await makeRoot();
        const { tool } = makeTool({ root });
        const input = { script: SCRIPT, inputs: [PINNED_PATH], output: "yield.csv" };

        expect(tool.describeCall!(input)).toBe("derive yield.csv");
        const result = await derive(tool, {});
        expect(tool.describeResult!(input, result)).toBe(`${reportSessionDir("t1")}/derived/yield.csv`);
    });
});

describe("the bounds of a derivation", () => {
    it("refuses an input that the pinned evidence does not hold, and it starts no container", async () => {
        const root = await makeRoot();
        const { tool, sandbox } = makeTool({ root });

        const result = await derive(tool, { inputs: [PINNED_PATH, "runs/r9/output/absent.csv"] });

        expect(result.outcome).toBe("absent-input");
        if (result.outcome === "absent-input") {
            expect(result.path).toBe("runs/r9/output/absent.csv");
        }
        // The refusal reads the membership alone, thus no container starts.
        expect(sandbox.creates).toHaveLength(0);
    });

    it("refuses a name that the membership already holds", async () => {
        const root = await makeRoot();
        const held = `${reportSessionDir("t1")}/derived/yield.csv`;
        const snapshot: ReportSnapshot = { artifacts: { [PINNED_PATH]: { hash: PINNED_HASH }, [held]: { hash: "sha256:bbb222" } } };
        const { tool, sandbox } = makeTool({ root, snapshot });

        const result = await derive(tool, {});

        expect(result.outcome).toBe("repeated-name");
        if (result.outcome === "repeated-name") {
            expect(result.outputPath).toBe(held);
        }
        expect(sandbox.creates).toHaveLength(0);
    });

    it("refuses a record that another turn landed first", async () => {
        const root = await makeRoot();
        const { tool } = makeTool({ root, ledger: makeLedger("duplicate") });

        // The membership held no such name at the load, thus the name rule of the store is the last word.
        const result = await derive(tool, {});
        expect(result.outcome).toBe("repeated-name");
    });

    it("refuses a script that is over the cap", async () => {
        const root = await makeRoot();
        const { tool, sandbox } = makeTool({ root });

        const result = await derive(tool, { script: "#".repeat(64 * 1024 + 1) });

        expect(result.outcome).toBe("script-too-large");
        if (result.outcome === "script-too-large") {
            expect(result.cap).toBe(64 * 1024);
            expect(result.bytes).toBe(64 * 1024 + 1);
        }
        expect(sandbox.creates).toHaveLength(0);
    });

    it("refuses more inputs than the cap, and it counts a repeated path one time", async () => {
        const root = await makeRoot();
        const artifacts: ReportSnapshot["artifacts"] = {};
        for (let index = 0; index < 21; index += 1) {
            artifacts[`runs/r1/output/f${String(index)}.csv`] = { hash: `sha256:${String(index)}` };
        }
        const { tool } = makeTool({ root, snapshot: { artifacts } });

        const many = Object.keys(artifacts);
        const result = await derive(tool, { inputs: many });
        expect(result.outcome).toBe("too-many-inputs");
        if (result.outcome === "too-many-inputs") {
            expect(result.count).toBe(21);
            expect(result.cap).toBe(20);
        }

        // A repeated path names one source, thus a list of one path repeated is inside the cap.
        const repeated = await derive(tool, { inputs: new Array<string>(30).fill(many[0]!), output: "one.csv" });
        expect(repeated.outcome).toBe("derived");
    });

    it("refuses an output name that names a directory or a traversal", async () => {
        const root = await makeRoot();
        const { tool, sandbox } = makeTool({ root });

        for (const name of ["../escape.csv", "sub/dir.csv", "..", "with space.csv"]) {
            const result = await derive(tool, { output: name });
            expect(result.outcome).toBe("unsafe-name");
        }
        expect(sandbox.creates).toHaveLength(0);
    });
});

describe("a derivation that gives no table", () => {
    it("gives the sandbox detail of a failed script, and it revokes", async () => {
        const root = await makeRoot();
        const { tool, sandbox, ledger, auth } = makeTool({
            root,
            result: execResult({ exitCode: 1, stdout: "", stderr: "Traceback: KeyError: 'gene'" }),
        });

        const result = await derive(tool, {});

        expect(result.outcome).toBe("exec-failed");
        if (result.outcome === "exec-failed") {
            expect(result.detail).toContain("KeyError");
        }
        // No table means no record, and the container still goes away.
        expect(ledger.records).toHaveLength(0);
        expect(sandbox.teardowns).toEqual(["sbx-derive-1"]);
        expect(auth.revoked).toEqual(["derive-table-failed"]);
    });

    it("gives a timeout and a dead sandbox as a failed exec", async () => {
        expect(describeExecFailure(execResult({ timedOut: true }))).toContain("deadline");
        expect(describeExecFailure(execResult({ syntheticFailure: { reason: "sandbox-dead" } }))).toContain("sandbox-dead");
        expect(describeExecFailure(execResult({}))).toBeUndefined();
    });

    it("gives no-output for a green script that wrote no file", async () => {
        const root = await makeRoot();
        // The script exits clean and it writes nothing into the mount, thus the output path holds no file.
        const sandbox = makeSandbox({ root, reply: execResult({ stdout: "a log line\n" }) });
        const { tool, ledger, auth } = makeTool({ root, sandbox });

        const result = await derive(tool, {});

        expect(result.outcome).toBe("no-output");
        if (result.outcome === "no-output") {
            expect(result.detail).toContain("yield.csv");
        }
        expect(ledger.records).toHaveLength(0);
        expect(auth.revoked).toEqual(["derive-table-failed"]);
    });

    it("clears the output path first, thus a stale file is never adopted as the new table", async () => {
        const root = await makeRoot();
        const stale = join(root, reportSessionDir("t1"), "derived", "yield.csv");
        await mkdir(dirname(stale), { recursive: true });
        await writeFile(stale, "stale,bytes\n1,2\n", "utf8");
        // The script exits clean and it writes no file. The bytes of the failed attempt before it must not
        // become the table of this one.
        const sandbox = makeSandbox({ root, reply: execResult({ stdout: "a log line\n" }) });
        const { tool, ledger } = makeTool({ root, sandbox });

        const result = await derive(tool, {});

        expect(result.outcome).toBe("no-output");
        expect(ledger.records).toHaveLength(0);
        expect(existsSync(stale)).toBe(false);
    });

    it("refuses an output that resolves outside the workspace tree", async () => {
        const root = await makeRoot();
        const outside = join(await makeRoot(), "secret.csv");
        await writeFile(outside, "user,secret\n", "utf8");
        // A script can leave a symbolic link at the output name. The host classifies the file before it
        // hashes one byte, thus the bytes of a host file never become evidence of the session.
        const sandbox = makeSandbox({
            root,
            write: async (outputHostPath) => {
                await mkdir(dirname(outputHostPath), { recursive: true });
                await symlink(outside, outputHostPath);
            },
        });
        const { tool, ledger } = makeTool({ root, sandbox });

        const result = await derive(tool, {});

        expect(result.outcome).toBe("exec-failed");
        if (result.outcome === "exec-failed") {
            expect(result.detail).toContain("outside the workspace tree");
        }
        expect(ledger.records).toHaveLength(0);
    });

    it("tears the container down when the exec throws", async () => {
        const root = await makeRoot();
        const sandbox = makeSandbox({ root, throws: true });
        const { tool, auth } = makeTool({ root, sandbox });

        const result = await derive(tool, {});

        expect(result.outcome).toBe("exec-failed");
        expect(sandbox.teardowns).toEqual(["sbx-derive-1"]);
        expect(auth.revoked).toEqual(["derive-table-failed"]);
    });

    it("revokes the authorization when the work throws", async () => {
        const root = await makeRoot();
        // A stored path is untrusted text. One that escapes the tree makes the host-to-container mapper
        // throw, and the authorization must not stand behind that throw.
        const hostile = "../../etc/passwd";
        const { tool, auth, sandbox } = makeTool({ root, snapshot: { artifacts: { [hostile]: { hash: PINNED_HASH } } } });

        const attempt = async (): Promise<void> => {
            (await tool.execute({ script: SCRIPT, inputs: [hostile], output: "yield.csv" }, ctxForThread("t1")))._unsafeUnwrap();
        };

        await expect(attempt()).rejects.toThrow(/escapes the workspace root/);
        expect(auth.revoked).toEqual(["derive-table-failed"]);
        expect(sandbox.creates).toHaveLength(0);
    });

    it("reports a ledger fault as a failed derivation", async () => {
        const root = await makeRoot();
        const fault: DbError = { type: "mutation_failed", op: "append", cause: new Error("the pool is down") };
        const { tool, auth } = makeTool({ root, ledger: makeLedger(undefined, fault) });

        const result = await derive(tool, {});

        expect(result.outcome).toBe("exec-failed");
        expect(auth.revoked).toEqual(["derive-table-failed"]);
    });
});

describe("a composition with no sandbox", () => {
    it("reports that it cannot derive, and it reads no state", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", pinnedSnapshot());
        const tool = createDeriveTableTool({ gateway, resolveWorkspaceRoot: () => root, derivations: makeLedger() });

        const result = (await tool.execute({ script: SCRIPT, inputs: [PINNED_PATH], output: "yield.csv" }, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("unavailable");
    });

    it("submits an exec id that names the workflow that awaits it", async () => {
        // A callback host reads the owner workflow out of the exec id alone. A flat id makes the completion
        // callback unroutable, and the exec then settles on the pull backstop alone.
        const root = await makeRoot();
        const { tool, sandbox } = makeTool({ root });

        await derive(tool, {});

        const submitted = sandbox.submits[0];
        expect(submitted).toBeDefined();
        expect(workflowIdFromExec(submitted!.execId)).not.toBeNull();
        expect(sandbox.creates[0]!.childWorkflowId).toBe(workflowIdFromExec(submitted!.execId));
    });

    it("derives whatever transport the client awaits under, because the container runs in a workflow", async () => {
        // The runner is a registered workflow, thus the await is a body call under each transport. The tool
        // reads no transport at all, and no composition refuses for one.
        const root = await makeRoot();
        const { tool, sandbox, ledger } = makeTool({ root });

        expect((await derive(tool, {})).outcome).toBe("derived");
        expect(sandbox.creates).toHaveLength(1);
        expect(sandbox.teardowns).toHaveLength(1);
        expect(ledger.records).toHaveLength(1);
    });

    it("refuses a call whose scope names no report thread", async () => {
        const root = await makeRoot();
        const { tool } = makeTool({ root });
        const { ctx } = makeToolContext();

        const result = (await tool.execute({ script: SCRIPT, inputs: [PINNED_PATH], output: "yield.csv" }, ctx))._unsafeUnwrap();

        expect(result.outcome).toBe("refused");
        if (result.outcome === "refused") {
            expect(result.refusal.reason).toBe("no-thread-scope");
        }
    });
});

describe("the disposal of a session", () => {
    it("puts the derived table inside the directory that the disposal removes", async () => {
        const root = await makeRoot();
        const { tool } = makeTool({ root });

        const result = await derive(tool, {});
        if (result.outcome !== "derived") throw new Error("expected a derived table");

        const sessionDir = join(root, reportSessionDir("t1"));
        expect(existsSync(join(root, result.path))).toBe(true);
        // A host removes the whole directory of a session when its pages dispose. The derived table sits
        // under that one directory, thus it goes with the disposal and no second sweep names it.
        await rm(sessionDir, { recursive: true, force: true });
        expect(existsSync(join(root, result.path))).toBe(false);
        expect(existsSync(sessionDir)).toBe(false);
    });
});

describe("buildDerivationExec", () => {
    it("runs the script through python -c inside the write mount", () => {
        const body = buildDerivationExec({
            script: "print(1)",
            execId: "exec-9",
            workingDir: "/an-1/report-sessions/t1/derived",
            inputs: [{ path: "/an-1/data/x.csv", hash: "sha256:h1" }],
            output: "/an-1/report-sessions/t1/derived/y.csv",
        });

        expect(body.command).toEqual(["python3", "-c", "print(1)"]);
        expect(body.execId).toBe("exec-9");
        expect(body.cwd).toBe("/an-1/report-sessions/t1/derived");
        expect(body.timeoutSeconds).toBe(300);
        expect(JSON.parse(body.env![DERIVE_INPUT_ENV])).toEqual([{ path: "/an-1/data/x.csv", hash: "sha256:h1" }]);
        expect(body.env![DERIVE_OUTPUT_ENV]).toBe("/an-1/report-sessions/t1/derived/y.csv");
    });
});
