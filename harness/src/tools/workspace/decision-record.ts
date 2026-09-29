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
 */

import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";

import type { AgentSession } from "../../auth/types.js";
import type { RunStep } from "../../loop/types.js";
import { unwrapOrThrow } from "../../lib/result.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import type { MutateToolName, WorkspaceMutator } from "./mutator.js";

/**
 * The path of the decision record of one rendered script inside the step:
 * `output/decision_record_<script stem>.json`. One record per render, thus a
 * step that renders two scripts keeps both records.
 */
export function decisionRecordPath(scriptFile: string): string {
    const stem = scriptFile.replace(/\.[A-Za-z0-9]+$/, "");
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

/** One change of a script after its render, as the record keeps it. */
export interface UnvettedEdit {
    readonly path: string;
    readonly note: string;
    /** The digest of the script after the change. */
    readonly sha256: string;
}

/** The digest the record expects of the script now: the last recorded change, else the bytes the render wrote. */
export function expectedScriptSha256(record: Readonly<Record<string, unknown>>): string | undefined {
    const edits = Array.isArray(record.unvetted_edits) ? (record.unvetted_edits as readonly Partial<UnvettedEdit>[]) : [];
    const last = edits[edits.length - 1]?.sha256;
    if (typeof last === "string") return last;
    return typeof record.written_sha256 === "string" ? record.written_sha256 : undefined;
}

export interface NoteScriptChangeArgs {
    readonly filesystem: WorkspaceFilesystem;
    readonly mutator: WorkspaceMutator;
    readonly session: AgentSession;
    /** Absolute host base for a relative path; the analysis root when absent. */
    readonly workingDir?: string;
    readonly invocationId: string;
    readonly runStep: RunStep;
    /** The tool that made the change, for the provenance of the record write. */
    readonly toolName: MutateToolName;
    /** The script path as the tool received it, relative or absolute. */
    readonly scriptPath: string;
    readonly note: string;
    /** The digest of the script after the change. */
    readonly sha256: string;
}

/**
 * Append a change to the record of a script. `no_record` when the path is
 * not a script under `scripts/`, or when no record exists for it, which is
 * the state of every script an agent wrote itself. `refused` when the
 * mutator refused the write of the record, for example a record of another
 * step, outside the writable prefix of this one.
 */
export async function noteScriptChange(args: NoteScriptChangeArgs): Promise<"noted" | "no_record" | "refused"> {
    const recordPath = decisionRecordPathFor(args.scriptPath);
    if (!recordPath) return "no_record";
    const read = unwrapOrThrow(
        await args.filesystem.readFile({ session: args.session, path: recordPath, ...(args.workingDir !== undefined ? { workingDir: args.workingDir } : {}) }),
    );
    if (read.kind !== "ok") return "no_record";
    let record: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(read.content.toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "no_record";
        record = parsed as Record<string, unknown>;
    } catch {
        return "no_record";
    }
    const edits = Array.isArray(record.unvetted_edits) ? (record.unvetted_edits as unknown[]) : [];
    const entry: UnvettedEdit = { path: args.scriptPath, note: args.note, sha256: args.sha256 };
    const next = { ...record, unvetted_edits: [...edits, entry] };
    const written = await args.mutator.writeFile({
        path: recordPath,
        content: `${JSON.stringify(next, null, 2)}\n`,
        toolName: args.toolName,
        invocationId: args.invocationId,
        runStep: args.runStep,
        session: args.session,
    });
    return written.status === "ok" ? "noted" : "refused";
}

export type ReconcileScriptRecordArgs = Omit<NoteScriptChangeArgs, "note" | "sha256">;

/**
 * Compare a script with the digest its record expects, before the script
 * runs. A difference is a change that no tool of the host recorded, and it
 * is noted with the digest of the bytes that are about to run. `unchanged`
 * when the digests agree, `no_record` when the script has no record.
 */
export async function reconcileScriptRecord(args: ReconcileScriptRecordArgs): Promise<"unchanged" | "noted" | "no_record" | "refused"> {
    const recordPath = decisionRecordPathFor(args.scriptPath);
    if (!recordPath) return "no_record";
    const base = args.workingDir !== undefined ? { workingDir: args.workingDir } : {};
    const record = unwrapOrThrow(await args.filesystem.readFile({ session: args.session, path: recordPath, ...base }));
    if (record.kind !== "ok") return "no_record";
    let expected: string | undefined;
    try {
        const parsed: unknown = JSON.parse(record.content.toString("utf8"));
        if (parsed === null || typeof parsed !== "object") return "no_record";
        expected = expectedScriptSha256(parsed as Record<string, unknown>);
    } catch {
        return "no_record";
    }
    if (expected === undefined) return "no_record";
    const script = unwrapOrThrow(await args.filesystem.readFile({ session: args.session, path: args.scriptPath, ...base }));
    if (script.kind !== "ok") return "no_record";
    const actual = scriptSha256(script.content);
    if (actual === expected) return "unchanged";
    return noteScriptChange({ ...args, note: "the script changed by a path no file tool recorded, before it ran", sha256: actual });
}
