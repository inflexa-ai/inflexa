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
 * the sandbox mounts it read-only. A write records no provenance, because the copy in the step carries it.
 */
export type DecisionRecordStore = {
    /** The host copy of the record at `path`, in the frame of the file tools, or `undefined` when the host holds none. */
    read(args: { readonly session: AgentSession; readonly path: string; readonly workingDir?: string }): Promise<Buffer | undefined>;
    /** Land the host copy of the record at `path`, in the frame of the file tools. */
    write(args: {
        readonly session: AgentSession;
        readonly path: string;
        readonly workingDir?: string;
        readonly content: string;
        readonly invocationId: string;
    }): Promise<"ok" | "out_of_prefix" | "symlink_denied">;
};

export function createDecisionRecordStore(deps: { readonly resolveWorkspaceRoot: ResolveWorkspaceRoot }): DecisionRecordStore {
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

/**
 * The outcome of a check of a script before it runs: a change note, or `unchanged` when the script is the one the
 * record expects, or `restored` when the script is unchanged and the copy of its record in the step was written again.
 */
export type ScriptRecordCheck = ScriptChangeNote | { readonly status: "unchanged" } | { readonly status: "restored"; readonly write: WriteRecord };

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
 * has one, takes the change also when the mutator refuses the copy in the step, for example a symlink in its place or
 * a copy of another step. Thus a change never hides behind a copy that a command broke. A note on the host only
 * appends a true digest to a record that the host holds already.
 */
async function appendChange(args: ReconcileScriptRecordArgs, recordPath: string, held: HeldRecord, entry: UnvettedEdit): Promise<ScriptChangeNote> {
    const edits = isUnknownArray(held.record.unvetted_edits) ? held.record.unvetted_edits : [];
    const content = `${JSON.stringify({ ...held.record, unvetted_edits: [...edits, entry] }, null, 2)}\n`;
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
    const held = await readHeldRecord(args, recordPath);
    if (!held) return { status: "no_record" };
    return appendChange(args, recordPath, held, { path: args.scriptPath, note: args.note, sha256: args.sha256 });
}

export type ReconcileScriptRecordArgs = Omit<NoteScriptChangeArgs, "note" | "sha256">;

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
    const held = await readHeldRecord(args, recordPath);
    if (!held) return { status: "no_record" };
    const expected = expectedScriptSha256(held.record);
    if (expected === undefined) return { status: "no_record" };
    const base = args.workingDir !== undefined ? { workingDir: args.workingDir } : {};
    const script = unwrapOrThrow(await args.filesystem.readFile({ session: args.session, path: args.scriptPath, ...base }));
    if (script.kind !== "ok") return { status: "no_record" };
    const actual = scriptSha256(script.content);
    if (actual !== expected) {
        return appendChange(args, recordPath, held, {
            path: args.scriptPath,
            note: "the script changed by a path no file tool recorded, before it ran",
            sha256: actual,
        });
    }
    if (held.hostBytes === undefined || held.copyMatches) return { status: "unchanged" };
    const written = await args.mutator.writeFile({
        path: recordPath,
        content: held.hostBytes.toString("utf8"),
        toolName: args.toolName,
        invocationId: args.invocationId,
        session: args.session,
    });
    return written.status === "ok" ? { status: "restored", write: written.record } : { status: "refused" };
}
