/**
 * The decision record of a rendered script, as the file tools keep it true
 * after the render. `knowledge_template` writes the record beside the
 * script with the digest of the bytes it wrote. A later change of the
 * script through `edit_file` appends an entry to `unvetted_edits` with the
 * digest after the change, and `execute_command` compares the script it is
 * about to run with the last recorded digest, thus a change by any other
 * path is recorded before the script runs. The record then connects the
 * cited decision to the bytes that ran, and an empty `unvetted_edits` is a
 * fact and not an assumption.
 *
 * Each write of a record lands two copies: the copy in `output/` of the step,
 * which the agents read, and the host copy under `DECISION_RECORD_ROOT`,
 * which no agent can write. The host copy is the record. A copy in `output/`
 * that a command removed or changed is written again from the host copy
 * before the script runs.
 */

import { stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { posix as posixPath, resolve as resolvePath, sep } from "node:path";
import { z } from "zod";

import { scopeResource, type AgentSession } from "../../auth/types.js";
import { classifyWithinRoot } from "../../lib/fs-helpers.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { safeParseJsonAs } from "../../lib/parse-json.js";
import { isUnknownArray } from "../../lib/unknown-array.js";
import { UnknownRecordSchema } from "../../lib/unknown-containers.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import { DECISION_RECORD_ROOT, resolveWorkspacePath, type ResolveWorkspaceRoot } from "../../workspace/paths.js";
import { landWithinRoot, type MutateToolName, type WorkspaceMutator, type WriteRecord } from "./mutator.js";

/**
 * The path of the decision record of one rendered script inside the step:
 * `output/decision_record_<script stem>.json`. One record per render, thus a
 * step that renders two scripts keeps both records.
 */
export function decisionRecordPath(scriptFile: string): string {
    const dot = scriptFile.lastIndexOf(".");
    const suffix = scriptFile.slice(dot + 1);
    const isSuffixAlnum =
        dot !== -1 &&
        suffix.length > 0 &&
        Array.from(suffix).every((char) => (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || (char >= "0" && char <= "9"));
    const stem = isSuffixAlnum ? scriptFile.slice(0, dot) : scriptFile;
    return `output/decision_record_${stem}.json`;
}

/**
 * The record path of a script path, or `undefined` when the path is not a
 * script under `scripts/`. A relative `scripts/x.R` gives the relative
 * record path, and an absolute `/<analysisId>/.../scripts/x.R` gives the
 * absolute one, beside it in the same step.
 */
export function decisionRecordPathFor(scriptPath: string): string | undefined {
    const dir = posixPath.dirname(scriptPath);
    if (posixPath.basename(dir) !== "scripts") return undefined;
    const record = decisionRecordPath(posixPath.basename(scriptPath));
    return dir === "scripts" ? record : posixPath.join(posixPath.dirname(dir), record);
}

export function scriptSha256(content: string | Uint8Array): string {
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** The largest host copy of a record that a read takes. */
const MAX_HOST_RECORD_BYTES = 256 * 1024;

/**
 * The host copies of the decision records: one file under `DECISION_RECORD_ROOT` of the workspace root for each
 * copy in a step, at the analysis-relative path of that copy. No file tool of an agent writes under the root, and
 * the sandbox mounts it read-only. A write records no provenance, because the copy in the step carries it. A write
 * takes only a record whose copy is under the write prefix of the caller, the same lexical bound as the mutator.
 */
export type DecisionRecordStore = {
    /** The host copy of the record at `path`, in the frame of the file tools, or `undefined` when the host holds none. */
    read(args: { readonly session: AgentSession; readonly path: string; readonly workingDir?: string }): Promise<Buffer | undefined>;
    /** Land the host copy of the record at `path`, in the frame of the file tools. `out_of_prefix` for a copy outside the write prefix. */
    write(args: {
        readonly session: AgentSession;
        readonly path: string;
        readonly workingDir?: string;
        readonly content: string;
        readonly invocationId: string;
    }): Promise<"ok" | "out_of_prefix" | "symlink_denied">;
};

export type DecisionRecordStoreDeps = {
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /**
     * The host directory that bounds each write: the working directory of a step agent, thus a tool of one step
     * never writes the record of another step. Absent, the analysis root bounds it, as for the session mutator.
     */
    readonly writePrefix?: string;
};

export function createDecisionRecordStore(deps: DecisionRecordStoreDeps): DecisionRecordStore {
    const rootOf = async (session: AgentSession): Promise<{ readonly analysisId: string; readonly workspaceRoot: string; readonly root: string }> => {
        const { resourceId: analysisId } = scopeResource(session.scope);
        const workspaceRoot = await deps.resolveWorkspaceRoot(analysisId);
        return { analysisId, workspaceRoot, root: resolvePath(workspaceRoot, DECISION_RECORD_ROOT) };
    };
    return {
        async read({ session, path, workingDir }) {
            const { analysisId, workspaceRoot, root } = await rootOf(session);
            const resolved = resolveWorkspacePath({ workspaceRoot, analysisId, path, workingDir });
            if (resolved.kind !== "ok") return undefined;
            return readHostRecord(root, resolved.relative);
        },
        async write({ session, path, workingDir, content, invocationId }) {
            const { analysisId, workspaceRoot, root } = await rootOf(session);
            const resolved = resolveWorkspacePath({ workspaceRoot, analysisId, path, workingDir });
            if (resolved.kind !== "ok") return "out_of_prefix";
            // The bound is lexical, as the resolver of the mutator: a symlink in place of `output/` of the own step
            // stays inside it, and the copy of another step stays outside it.
            const prefix = resolvePath(deps.writePrefix ?? workspaceRoot);
            if (resolved.absolute !== prefix && !resolved.absolute.startsWith(prefix + sep)) return "out_of_prefix";
            return landWithinRoot({ root, absolute: resolvePath(root, resolved.relative), content, stagingKey: invocationId });
        },
    };
}

/** The bytes of the host copy at `relative` under `root`, or `undefined` when no file of the permitted size is there. */
async function readHostRecord(root: string, relative: string): Promise<Buffer | undefined> {
    const absolute = resolvePath(root, relative);
    if (!absolute.startsWith(root + sep)) return undefined;
    if ((await classifyWithinRoot(root, absolute)) !== "in") return undefined;
    const info = await stat(absolute);
    if (!info.isFile() || info.size > MAX_HOST_RECORD_BYTES) return undefined;
    return readFile(absolute);
}

/** One change of a script after its render, as the record keeps it. */
export type UnvettedEdit = {
    readonly path: string;
    readonly note: string;
    /** The digest of the script after the change. */
    readonly sha256: string;
};

const LastEditRecordSchema = z.looseObject({ sha256: z.string() });

/** The digest the record expects of the script now: the last recorded change, else the bytes the render wrote. */
export function expectedScriptSha256(record: Readonly<Record<string, unknown>>): string | undefined {
    const edits = isUnknownArray(record.unvetted_edits) ? record.unvetted_edits : [];
    const parsed = LastEditRecordSchema.safeParse(edits.at(-1));
    if (parsed.success) return parsed.data.sha256;
    return typeof record.written_sha256 === "string" ? record.written_sha256 : undefined;
}

export type NoteScriptChangeArgs = {
    readonly filesystem: WorkspaceFilesystem;
    readonly mutator: WorkspaceMutator;
    readonly records: DecisionRecordStore;
    readonly session: AgentSession;
    /** Absolute host base for a relative path; the analysis root when absent. */
    readonly workingDir?: string;
    readonly invocationId: string;
    /** The tool that made the change, for the provenance of the record write. */
    readonly toolName: MutateToolName;
    /** The script path as the tool received it, relative or absolute. */
    readonly scriptPath: string;
    readonly note: string;
    /** The digest of the script after the change. */
    readonly sha256: string;
};

/**
 * The outcome of a change note. `noted` carries the record of the write of
 * the copy in the step, thus the calling tool carries it as its call record,
 * and its fold hands it to `recordWrite`. `copyWritten` is false when only the
 * host copy took the note, and then `writes` is empty. `restored` is true when
 * the copy in the step was absent or differed from the host copy before the
 * write.
 */
export type ScriptChangeNote =
    | { readonly status: "noted"; readonly writes: readonly WriteRecord[]; readonly restored: boolean; readonly copyWritten: boolean }
    | { readonly status: "no_record" | "refused" };

/** The digest of the script that a check before a run read. Present when the script has a record and the record took the check. */
type CheckedDigest = { readonly sha256?: string };

/**
 * The outcome of a check of a script before it runs: a change note, or `unchanged` when the script is the one the
 * record expects, or `restored` when the script is unchanged and the copy of its record in the step was written again.
 */
export type ScriptRecordCheck =
    | (ScriptChangeNote & CheckedDigest)
    | ({ readonly status: "unchanged" } & CheckedDigest)
    | ({ readonly status: "restored"; readonly write: WriteRecord } & CheckedDigest);

/**
 * A record that the tools found. `hostBytes` is the host copy, which is the record when present. Without it, the
 * record is the copy in the step: a record that an earlier version wrote, before the host kept a copy. A change of
 * such a record stays in the step, thus a file that an agent wrote never becomes a host record.
 */
type HeldRecord = {
    readonly record: Readonly<Record<string, unknown>>;
    readonly hostBytes: Buffer | undefined;
    /** True when the copy in the step equals the host copy, byte for byte. */
    readonly copyMatches: boolean;
};

function parseRecord(bytes: Buffer): Readonly<Record<string, unknown>> | undefined {
    try {
        const parsed = safeParseJsonAs(bytes.toString("utf8"), UnknownRecordSchema);
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

async function readHeldRecord(args: ReconcileScriptRecordArgs, recordPath: string): Promise<HeldRecord | undefined> {
    const base = args.workingDir !== undefined ? { workingDir: args.workingDir } : {};
    const copy = unwrapOrThrow(await args.filesystem.readFile({ session: args.session, path: recordPath, ...base }));
    const copyBytes = copy.kind === "ok" ? copy.content : undefined;
    const hostBytes = await args.records.read({ session: args.session, path: recordPath, ...base });
    const bytes = hostBytes ?? copyBytes;
    if (bytes === undefined) return undefined;
    const record = parseRecord(bytes);
    if (record === undefined) return undefined;
    return { record, hostBytes, copyMatches: hostBytes !== undefined && copyBytes !== undefined && hostBytes.equals(copyBytes) };
}

/**
 * Append one change to a held record. The copy in the step lands through the mutator. The host copy, when the record
 * has one, takes the change also when the mutator refuses the copy in the step, for example a symlink in its place.
 * Thus a change never hides behind a copy that a command broke. The store bounds the host write to the write prefix
 * of the caller, thus the record of another step takes no note from this one.
 */
async function appendChange(args: ReconcileScriptRecordArgs, recordPath: string, held: HeldRecord, entry: UnvettedEdit): Promise<ScriptChangeNote> {
    const edits = isUnknownArray(held.record.unvetted_edits) ? held.record.unvetted_edits : [];
    return writeHeldRecord(args, recordPath, held, { ...held.record, unvetted_edits: [...edits, entry] });
}

/** Write the next state of a held record to the copy in the step and to the host copy, as `appendChange` states. */
async function writeHeldRecord(
    args: ReconcileScriptRecordArgs,
    recordPath: string,
    held: HeldRecord,
    next: Readonly<Record<string, unknown>>,
): Promise<ScriptChangeNote> {
    const content = `${JSON.stringify(next, null, 2)}\n`;
    const written = await args.mutator.writeFile({
        path: recordPath,
        content,
        toolName: args.toolName,
        invocationId: args.invocationId,
        session: args.session,
    });
    const writes = written.status === "ok" ? [written.record] : [];
    if (held.hostBytes === undefined) return written.status === "ok" ? { status: "noted", writes, restored: false, copyWritten: true } : { status: "refused" };
    const base = args.workingDir !== undefined ? { workingDir: args.workingDir } : {};
    const host = await args.records.write({ session: args.session, path: recordPath, ...base, content, invocationId: args.invocationId });
    if (host !== "ok") return { status: "refused" };
    return { status: "noted", writes, restored: written.status === "ok" && !held.copyMatches, copyWritten: written.status === "ok" };
}

/** The updates of a record that wait, by record. Each update reads the record and then writes it, and two tools can update one record at the same time. */
const recordQueues = new Map<string, Promise<unknown>>();

/**
 * Do `work` after each earlier update of the same record ends, with or without an error. The key is the analysis
 * and the file name of the record: one tool names the record by a relative path and a different tool by an
 * absolute path, and the file name is the same in the two. Thus the records of two steps with one file name also wait in one line.
 */
async function inRecordOrder<T>(args: ReconcileScriptRecordArgs, recordPath: string, work: () => Promise<T>): Promise<T> {
    const key = `${args.session.scope.analysisId}\n${posixPath.basename(recordPath)}`;
    const next = (recordQueues.get(key) ?? Promise.resolve()).then(work, work);
    recordQueues.set(key, next);
    try {
        return await next;
    } finally {
        if (recordQueues.get(key) === next) recordQueues.delete(key);
    }
}

/**
 * Append a change to the record of a script. `no_record` when the path is
 * not a script under `scripts/`, or when no record exists for it, which is
 * the state of every script an agent wrote itself. `refused` when the
 * mutator refused the write of the record, for example a record of another
 * step, outside the writable prefix of this one.
 */
export async function noteScriptChange(args: NoteScriptChangeArgs): Promise<ScriptChangeNote> {
    const recordPath = decisionRecordPathFor(args.scriptPath);
    if (!recordPath) return { status: "no_record" };
    return inRecordOrder(args, recordPath, async () => {
        const held = await readHeldRecord(args, recordPath);
        if (!held) return { status: "no_record" };
        return appendChange(args, recordPath, held, { path: args.scriptPath, note: args.note, sha256: args.sha256 });
    });
}

export type ReconcileScriptRecordArgs = Omit<NoteScriptChangeArgs, "note" | "sha256">;

/** One run of a script, as the record keeps it. */
export type ScriptRun = {
    /**
     * The exit code of the command that ran the script, or `null` when the sandbox ended under it. An entry with
     * no exit code is a run that started: the host wrote it before the command, and the command did not end yet.
     */
    readonly exit_code?: number | null;
    /**
     * The digest of the script as the check before the run read it. Absent when the host did the call again after
     * a recovery and the script then held different bytes: the host cannot tell which bytes ran.
     */
    readonly sha256?: string;
    /** The digest from before the command, in an entry with no `sha256`. */
    readonly sha256_before_the_command?: string;
    /** The digest that the call after the recovery read, in an entry with no `sha256`. */
    readonly sha256_at_the_recovery?: string;
    /** The tool call that ran the command. A call that the host does again after a recovery writes no second entry. */
    readonly invocation: string;
};

const RunEntrySchema = z.looseObject({
    invocation: z.string(),
    sha256: z.string().optional().catch(undefined),
    exit_code: z.number().nullable().optional().catch(undefined),
});

/** The most run entries that a record keeps. A script runs one time, or a small number of times. */
const MAX_RECORDED_RUNS = 50;

/** The position of the entry of a tool call in `runs`, with the entry, or `undefined` when the call has none. */
function runOfInvocation(
    runs: readonly unknown[],
    invocationId: string,
): { readonly index: number; readonly sha256: string | undefined; readonly ended: boolean } | undefined {
    for (const [index, run] of runs.entries()) {
        const parsed = RunEntrySchema.safeParse(run);
        if (!parsed.success || parsed.data.invocation !== invocationId) continue;
        return { index, ended: parsed.data.exit_code !== undefined, sha256: parsed.data.sha256 };
    }
    return undefined;
}

/** The outcome of the entry that the host writes before a command runs a script. */
export type ScriptRunStart = { readonly status: "started"; readonly writes: readonly WriteRecord[] } | { readonly status: "no_record" | "refused" };

/**
 * Write the entry of a run to the record of a script before the command runs, with the digest that the check
 * before the run read and with no exit code. The host can stop after this write. The call that the host then
 * does again finds this entry and writes no second one. `no_record` when the script has no record.
 */
export async function startScriptRun(args: ReconcileScriptRecordArgs & { readonly sha256: string }): Promise<ScriptRunStart> {
    const recordPath = decisionRecordPathFor(args.scriptPath);
    if (!recordPath) return { status: "no_record" };
    return inRecordOrder(args, recordPath, async () => {
        const held = await readHeldRecord(args, recordPath);
        if (!held) return { status: "no_record" };
        const runs = isUnknownArray(held.record.runs) ? held.record.runs : [];
        // The entry of this call is there: the host does the call again, and the entry of the first time stands.
        if (runOfInvocation(runs, args.invocationId)) return { status: "started", writes: [] };
        const entry: ScriptRun = { sha256: args.sha256, invocation: args.invocationId };
        const written = await writeHeldRecord(args, recordPath, held, { ...held.record, runs: [...runs, entry].slice(-MAX_RECORDED_RUNS) });
        return written.status === "noted" ? { status: "started", writes: written.writes } : { status: written.status };
    });
}

/**
 * Give the run entry of a tool call its exit code, after the command that ran the script. The record then says
 * that the script ran, with which bytes, and how the command ended. A step that fits the same model again takes
 * the slot values of a record only when a run of the rendered bytes ended with exit code 0. The function reads
 * the record again, thus a change note that landed while the command ran stays. A call with no entry from before
 * the command gets a new entry. `no_record` when the script has no record.
 *
 * The host can stop before the command or after it, and it then does the call again. The entry from before the
 * command does not say which of the two occurred. When the digest of this call is the digest of that entry, the
 * same bytes ran in the two cases. When the two differ, the host cannot tell which bytes ran: the entry then
 * holds the two digests and no `sha256`, thus it is a run of no known script.
 */
export async function noteScriptRun(args: ReconcileScriptRecordArgs & ScriptRunArgs): Promise<ScriptChangeNote> {
    const recordPath = decisionRecordPathFor(args.scriptPath);
    if (!recordPath) return { status: "no_record" };
    return inRecordOrder(args, recordPath, async () => {
        const held = await readHeldRecord(args, recordPath);
        if (!held) return { status: "no_record" };
        const runs = isUnknownArray(held.record.runs) ? held.record.runs : [];
        const known = runOfInvocation(runs, args.invocationId);
        // The entry of this call has its exit code: the host does the call again after a recovery, and the command ran one time.
        if (known?.ended) return { status: "noted", writes: [], restored: false, copyWritten: true };
        const entry: ScriptRun =
            known === undefined || known.sha256 === args.sha256
                ? { exit_code: args.exitCode, sha256: args.sha256, invocation: args.invocationId }
                : { exit_code: args.exitCode, sha256_before_the_command: known.sha256, sha256_at_the_recovery: args.sha256, invocation: args.invocationId };
        const next = known ? runs.map((run, index) => (index === known.index ? entry : run)) : [...runs, entry].slice(-MAX_RECORDED_RUNS);
        return writeHeldRecord(args, recordPath, held, { ...held.record, runs: next });
    });
}

type ScriptRunArgs = { readonly exitCode: number | null; readonly sha256: string };

/**
 * Compare a script with the digest its record expects, before the script
 * runs. A difference is a change that no tool of the host recorded, and it
 * is noted with the digest of the bytes that are about to run. When the
 * digests agree and the copy of the record in the step is absent or differs
 * from the host copy, the host copy is written to the step again. `no_record`
 * when the script has no record.
 */
export async function reconcileScriptRecord(args: ReconcileScriptRecordArgs): Promise<ScriptRecordCheck> {
    const recordPath = decisionRecordPathFor(args.scriptPath);
    if (!recordPath) return { status: "no_record" };
    return inRecordOrder(args, recordPath, () => reconcileHeldRecord(args, recordPath));
}

async function reconcileHeldRecord(args: ReconcileScriptRecordArgs, recordPath: string): Promise<ScriptRecordCheck> {
    const held = await readHeldRecord(args, recordPath);
    if (!held) return { status: "no_record" };
    const expected = expectedScriptSha256(held.record);
    if (expected === undefined) return { status: "no_record" };
    const base = args.workingDir !== undefined ? { workingDir: args.workingDir } : {};
    const script = unwrapOrThrow(await args.filesystem.readFile({ session: args.session, path: args.scriptPath, ...base }));
    if (script.kind !== "ok") return { status: "no_record" };
    const actual = scriptSha256(script.content);
    if (actual !== expected) {
        const noted = await appendChange(args, recordPath, held, {
            path: args.scriptPath,
            note: "the script changed by a path no file tool recorded, before it ran",
            sha256: actual,
        });
        return noted.status === "noted" ? { ...noted, sha256: actual } : noted;
    }
    if (held.hostBytes === undefined || held.copyMatches) return { status: "unchanged", sha256: actual };
    const written = await args.mutator.writeFile({
        path: recordPath,
        content: held.hostBytes.toString("utf8"),
        toolName: args.toolName,
        invocationId: args.invocationId,
        session: args.session,
    });
    return written.status === "ok" ? { status: "restored", write: written.record, sha256: actual } : { status: "refused" };
}
