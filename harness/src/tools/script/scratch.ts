/**
 * The scratch directory of a session: the scripts that `run_script` ran, and the files that those scripts derived.
 *
 * A conversation keeps them at `conversation-sessions/{threadId}/`. `scripts/` holds each script under the id of
 * its call, saved before the script runs, thus a failed script is on record too. `derived/` holds each file that a
 * script wrote, and it is the one place where a script can write: an input and a run output stay out of its reach.
 *
 * A derived name holds one file for the life of the session, because a reply can cite the file as its evidence.
 * A second write of the name with other bytes is refused. The same bytes again pass with no write, thus a step that
 * runs its script again after a crash lands nothing new.
 */

import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { AgentSession } from "../../auth/types.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import { computeSha256, computeSha256File } from "../../lib/fs-helpers.js";
import { tryFs } from "../../lib/fs-result.js";
import type { Logger } from "../../lib/logger.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { bindSessionEmit, type ProvenanceSeam, type SessionProvenanceEvent } from "../../provenance/seam.js";
import { isSafeId, type ResolveWorkspaceRoot } from "../../workspace/paths.js";
import { confinedWrite } from "../workspace/mutator.js";

/** The cap of one derived file. It matches the cap of a table read, thus a script can read back what it wrote. */
export const DERIVED_FILE_CAP_BYTES = 16 * 1024 * 1024;

/** The cap of the derived files of one session together. */
export const DERIVED_SESSION_CAP_BYTES = 256 * 1024 * 1024;

/** One file of the scratch directory: the analysis-relative path, and the hash and the size of its bytes. */
export type ScratchFile = {
    readonly path: string;
    readonly hash: string;
    readonly size: number;
};

/** A file that a script read: the analysis-relative path and the hash of the bytes that it read. */
export type ScriptRead = {
    readonly path: string;
    readonly hash: string;
};

export type DerivedWrite = { readonly status: "written"; readonly file: ScratchFile } | { readonly status: "refused"; readonly reason: string };

/**
 * What one script did to files, for provenance. The harness writes the script before it runs, and each script tool
 * that reads or writes a file gives its part as the call record of the nested call.
 */
export type ScriptRunRecord = {
    readonly analysisId: string;
    readonly threadId?: string;
    /** The id of the `run_script` call. */
    readonly invocationId: string;
    /** The saved script. Absent when the session has no thread, thus no scratch directory. */
    readonly script?: ScratchFile;
    readonly reads: readonly ScriptRead[];
    readonly writes: readonly ScratchFile[];
    /** Each tool that the script called, in the order of the calls. */
    readonly tools: readonly string[];
    readonly ok: boolean;
};

export type ScriptScratch = {
    /** Save the code of one script before it runs. Gives `undefined` when the scope of the session names no thread. */
    saveScript(args: { readonly session: AgentSession; readonly invocationId: string; readonly code: string }): Promise<ScratchFile | undefined>;
    /** Write one derived file. A refusal is data that the script reads as a failed call. */
    writeDerived(args: {
        readonly session: AgentSession;
        readonly invocationId: string;
        readonly name: string;
        /** Text lands as UTF-8. */
        readonly content: string | Uint8Array;
    }): Promise<DerivedWrite>;
    /** Record what one script did to files. A script that read and wrote nothing records nothing. */
    recordRun(record: ScriptRunRecord): void;
};

export type ScriptScratchDeps = {
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /** The scratch directory of one thread, workspace-root-relative, for example `conversationSessionDir`. */
    readonly sessionDir: (threadId: string) => string;
    /** The provenance seam. An unbound session emit records nothing, and the scripts run the same. */
    readonly provenance?: ProvenanceSeam;
    readonly logger?: Logger;
};

/** The file name of a script. A call id that is not a safe file name is hashed, thus each id gives one name. */
function scriptFileName(invocationId: string): string {
    const stem = isSafeId(invocationId) ? invocationId : computeSha256(Buffer.from(invocationId, "utf8")).slice(0, 32);
    return `${stem}.js`;
}

/** A derived name is one file name: no directory, no separator, no traversal, and no hidden file. */
function isDerivedName(name: string): boolean {
    return isSafeId(name) && !name.startsWith(".") && name.length <= 128;
}

/** What is at the path of a derived name: nothing, a regular file with its hash, or something else. */
type Existing = { readonly kind: "absent" } | { readonly kind: "file"; readonly hash: string } | { readonly kind: "other" };

async function existingAt(absolute: string): Promise<Existing> {
    const stats = unwrapOrThrow(await tryFs<Stats | null>("scratch.lstatDerived", () => lstat(absolute), { path: absolute, onAbsent: () => null }));
    if (stats === null) return { kind: "absent" };
    if (!stats.isFile()) return { kind: "other" };
    return { kind: "file", hash: await computeSha256File(absolute) };
}

/** The bytes of the regular files of one directory. A directory that is not there holds none. */
async function directoryBytes(absolute: string): Promise<number> {
    const entries = unwrapOrThrow(
        await tryFs<Dirent[]>("scratch.readDerived", () => readdir(absolute, { withFileTypes: true }), { path: absolute, onAbsent: () => [] }),
    );
    let total = 0;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const path = join(absolute, entry.name);
        const stats = unwrapOrThrow(await tryFs<Stats | null>("scratch.lstatEntry", () => lstat(path), { path, onAbsent: () => null }));
        total += stats?.size ?? 0;
    }
    return total;
}

export function createScriptScratch(deps: ScriptScratchDeps): ScriptScratch {
    const logger = (deps.logger ?? createNoopLogger()).named("script-scratch");
    const observe = bindSessionEmit(deps.provenance, logger);

    async function land(
        session: AgentSession,
        dir: string,
        name: string,
        content: string | Uint8Array,
        invocationId: string,
    ): Promise<ScratchFile | { refused: string }> {
        const { analysisId } = session.scope;
        const workspaceRoot = await deps.resolveWorkspaceRoot(analysisId);
        const landed = await confinedWrite({
            workspaceRoot,
            analysisId,
            workingDir: join(workspaceRoot, dir),
            path: name,
            content,
            invocationId,
            beforeLand: undefined,
            refuseStagedInputs: true,
        });
        if (landed.status !== "ok") return { refused: `the write of ${dir}/${name} was refused (${landed.status})` };
        return { path: landed.relative, hash: computeSha256(landed.bytes), size: landed.bytes.length };
    }

    return {
        async saveScript({ session, invocationId, code }) {
            const { threadId } = session.scope;
            if (threadId === undefined) return undefined;
            const saved = await land(session, `${deps.sessionDir(threadId)}/scripts`, scriptFileName(invocationId), code, invocationId);
            if ("refused" in saved) throw new Error(saved.refused);
            return saved;
        },

        async writeDerived({ session, invocationId, name, content }) {
            const { analysisId, threadId } = session.scope;
            if (threadId === undefined) return { status: "refused", reason: "this session has no thread, thus a script has no directory to write in" };
            if (!isDerivedName(name)) {
                return {
                    status: "refused",
                    reason: "a name is one file name of letters, digits, '.', '_', and '-', with no directory, for example de_top50.csv",
                };
            }
            const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
            const bytes = data.length;
            if (bytes > DERIVED_FILE_CAP_BYTES) {
                return {
                    status: "refused",
                    reason: `the file is ${String(bytes)} bytes, and the cap of a derived file is ${String(DERIVED_FILE_CAP_BYTES)} bytes`,
                };
            }
            const dir = `${deps.sessionDir(threadId)}/derived`;
            const absoluteDir = join(await deps.resolveWorkspaceRoot(analysisId), dir);
            const hash = computeSha256(data);
            const existing = await existingAt(join(absoluteDir, name));
            if (existing.kind === "other") return { status: "refused", reason: `${dir}/${name} is not a regular file` };
            if (existing.kind === "file") {
                if (existing.hash === hash) return { status: "written", file: { path: `${dir}/${name}`, hash, size: bytes } };
                return { status: "refused", reason: `this session already holds a different ${name}, thus this file takes a new name` };
            }
            const used = await directoryBytes(absoluteDir);
            if (used + bytes > DERIVED_SESSION_CAP_BYTES) {
                return { status: "refused", reason: `the derived files of this session would pass the cap of ${String(DERIVED_SESSION_CAP_BYTES)} bytes` };
            }
            const landed = await land(session, dir, name, content, invocationId);
            if ("refused" in landed) return { status: "refused", reason: landed.refused };
            return { status: "written", file: landed };
        },

        recordRun(record) {
            if (record.reads.length === 0 && record.writes.length === 0) return;
            const event: Extract<SessionProvenanceEvent, { type: "run-script" }> = {
                type: "run-script",
                analysisId: record.analysisId,
                invocationId: record.invocationId,
                reads: record.reads.map((read) => ({ path: read.path, hash: read.hash })),
                writes: record.writes.map((write) => ({ path: write.path, hash: write.hash, size: write.size })),
                tools: [...record.tools],
                ok: record.ok,
            };
            if (record.threadId !== undefined) event.threadId = record.threadId;
            if (record.script !== undefined) event.script = { path: record.script.path, hash: record.script.hash, size: record.script.size };
            observe(event);
        },
    };
}
