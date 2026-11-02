/**
 * The script tools of a report session: `read_table` over the pinned evidence, and `write_derived`, which pins a
 * derived table to the session.
 *
 * A script reshapes the evidence into the table that a block binds: a join, a pivot, or an aggregate. The script
 * runs in the VM of `run_script`, thus a derivation starts no container. A table over 16 MiB does not derive.
 *
 * `read_table` reads only a member of the served snapshot, and it refuses bytes whose hash is not the pinned hash.
 * `write_derived` keeps the rules of a session derivation: the output lands under the derived directory of the session,
 * each declared input must be a member, a name that the session holds is refused, and the record chains the
 * table to its inputs and to the code of the script. A rerun of a call whose record landed gives that record
 * back, and it emits the derivation again.
 */

import { join } from "node:path";

import { ok, err, type Result } from "neverthrow";
import { z } from "zod";

import { createNoopLogger } from "../../lib/console-logger.js";
import { computeSha256 } from "../../lib/fs-helpers.js";
import type { Logger } from "../../lib/logger.js";
import { bindSessionEmit, type ProvenanceSeam } from "../../provenance/seam.js";
import { snapshotEntry } from "../../report-model/reference-resolver.js";
import type { DerivationRecord, DerivationSource, ReportSessionStateStore } from "../../state/report-session-state.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import { isSafeId, reportSessionDerivedDir, type ResolveWorkspaceRoot } from "../../workspace/paths.js";
import { defineTool, withToolCallRecord, type Tool, type ToolError, type WithToolCallRecord } from "../define-tool.js";
import { openReportThread, type ReportSessionStateGateway } from "../report-authoring/authoring-tools.js";
import { ReadTableOutputSchema, readTableRows, rowsText, type ScriptFileEffect } from "../script/file-tools.js";
import { DERIVED_FILE_CAP_BYTES } from "../script/scratch.js";
import { confinedWrite } from "../workspace/mutator.js";
import { syncWrittenFile, type SyncSessionFile } from "../../workspace/session-files.js";

export type ReportScriptToolsDeps = {
    readonly gateway: ReportSessionStateGateway;
    readonly workspaceFs: WorkspaceFilesystem;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly derivations: Pick<ReportSessionStateStore, "appendDerivation">;
    readonly provenance?: ProvenanceSeam;
    /** The host copy of each derived table, owned by the thread of the session. */
    readonly syncSessionFile?: SyncSessionFile;
    readonly logger?: Logger;
};

function refused(error: string): Result<never, ToolError> {
    return err({ error, retryable: false });
}

const readTableInput = z.object({
    path: z.string().min(1).describe("The path of a pinned artifact or of a derived table of this session, as `list_pinned_artifacts` gives it."),
    columns: z.array(z.string()).min(1).optional().describe("Keep only these columns. Absent: each column."),
});

type ReadTableOutput = WithToolCallRecord<
    { readonly path: string; readonly columns: readonly string[]; readonly rowCount: number; readonly rows: readonly Record<string, string | number>[] },
    ScriptFileEffect
>;

function createReadTableTool(deps: ReportScriptToolsDeps): Tool<z.infer<typeof readTableInput>, ReadTableOutput> {
    return defineTool({
        id: "read_table",
        description:
            "Read one table of the pinned evidence as rows: CSV, TSV, JSON (an array of flat objects), or parquet, up to 16 MiB. " +
            "Each row is an object keyed by column, and a cell that holds a plain number reads as a number. " +
            "A larger table does not derive; tell the user which table is absent.",
        inputSchema: readTableInput,
        outputSchema: ReadTableOutputSchema,
        view: "none",
        describeCall: ({ path }) => path,
        describeResult: (_input, result) => `${String(result.rowCount)} rows`,
        execute: async ({ path, columns }, ctx): Promise<Result<ReadTableOutput, ToolError>> => {
            const opened = await openReportThread(deps.gateway, ctx.session.scope);
            if (opened.isErr()) return refused(opened.error.detail);
            const entry = snapshotEntry(opened.value.state.snapshot, path);
            if (entry === undefined) return refused(`the pinned evidence of this session holds no artifact at ${path}; list_pinned_artifacts gives the paths`);
            const table = await readTableRows({
                workspaceFs: deps.workspaceFs,
                session: ctx.session,
                path,
                columns,
                tooLarge: "a larger table does not derive",
            });
            if (table.isErr()) return refused(table.error);
            const hash = computeSha256(table.value.source);
            if (hash !== entry.hash) return refused(`${path} changed after the session pinned it, thus its bytes are not the evidence of this session`);
            const { rows } = table.value;
            return ok(withToolCallRecord({ path, columns: table.value.columns, rowCount: rows.length, rows }, { reads: [{ path, hash }] }));
        },
    });
}

const writeDerivedInput = z.object({
    name: z
        .string()
        .min(1)
        .describe("The file name of the table, with no directory, for example 'yield_by_group.csv'. The extension picks the format: .csv, .tsv, or .json."),
    rows: z
        .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])))
        .describe("The rows of the table, each an object keyed by column."),
    inputs: z.array(z.string()).min(1).describe("The path of each pinned table that the script read for this table. The record pins the hash of each one."),
});

const DerivedOutputSchema = z.object({ path: z.string(), hash: z.string(), columns: z.array(z.string()).readonly() });

type DerivedOutput = WithToolCallRecord<{ readonly path: string; readonly hash: string; readonly columns: readonly string[] }, ScriptFileEffect>;

function derivedOutput(record: DerivationRecord, size: number, columns: readonly string[]): DerivedOutput {
    return withToolCallRecord(
        { path: record.outputPath, hash: record.outputHash, columns },
        { writes: [{ path: record.outputPath, hash: record.outputHash, size }] },
    );
}

function createWriteDerivedTool(deps: ReportScriptToolsDeps): Tool<z.infer<typeof writeDerivedInput>, DerivedOutput> {
    const logger = (deps.logger ?? createNoopLogger()).named("report-write-derived");
    const observe = bindSessionEmit(deps.provenance, logger);
    const observeDerived = (analysisId: string, threadId: string, record: DerivationRecord): void => {
        observe({
            type: "run-derivation",
            analysisId,
            threadId,
            outputPath: record.outputPath,
            outputHash: record.outputHash,
            scriptHash: record.scriptHash,
            sources: record.sources.map((source) => ({ path: source.path, hash: source.hash })),
        });
    };

    return defineTool({
        id: "write_derived",
        description:
            "Pin one derived table to this session, and give its path for a block to bind. " +
            "Name each pinned table that the script read in `inputs`. A name that this session already holds is refused, thus a second derivation of one table takes a new name.",
        inputSchema: writeDerivedInput,
        outputSchema: DerivedOutputSchema,
        view: "none",
        describeCall: ({ name }) => name,
        describeResult: (_input, result) => result.path,
        execute: async ({ name, rows, inputs }, ctx): Promise<Result<DerivedOutput, ToolError>> => {
            if (ctx.script === undefined) return refused("write_derived runs inside a script only");
            const opened = await openReportThread(deps.gateway, ctx.session.scope);
            if (opened.isErr()) return refused(opened.error.detail);
            const { threadId, analysisId, state, derivations } = opened.value;

            const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
            // A rerun of a call whose record landed gives that record back. The membership holds the output of
            // the record by now, thus the name test below would refuse the call its own table.
            const recorded = derivations.find((record) => record.toolCallId === ctx.invocationId);
            if (recorded !== undefined) {
                observeDerived(analysisId, threadId, recorded);
                return ok(derivedOutput(recorded, Buffer.byteLength(rowsText(name, rows) ?? "", "utf8"), columns));
            }

            if (!isSafeId(name)) return refused("the name is one file name, with no directory, no separator, and no traversal");
            const text = rowsText(name, rows);
            if (text === undefined) return refused(`${name} names no table format: end the name in .csv, .tsv, or .json`);
            const bytes = Buffer.byteLength(text, "utf8");
            if (bytes > DERIVED_FILE_CAP_BYTES)
                return refused(`the table is ${String(bytes)} bytes, and the cap of a derived table is ${String(DERIVED_FILE_CAP_BYTES)} bytes`);

            const sources: DerivationSource[] = [];
            for (const path of new Set(inputs)) {
                const entry = snapshotEntry(state.snapshot, path);
                if (entry === undefined) return refused(`the pinned evidence of this session holds no artifact at ${path}`);
                sources.push({ path, hash: entry.hash });
            }
            const dir = reportSessionDerivedDir(threadId);
            const outputPath = `${dir}/${name}`;
            if (snapshotEntry(state.snapshot, outputPath) !== undefined) {
                return refused(`the evidence of this session already holds ${outputPath}, thus this table takes a new name`);
            }

            const workspaceRoot = await deps.resolveWorkspaceRoot(analysisId);
            const landed = await confinedWrite({
                workspaceRoot,
                analysisId,
                workingDir: join(workspaceRoot, dir),
                path: name,
                content: text,
                invocationId: ctx.invocationId,
                beforeLand: undefined,
                refuseStagedInputs: true,
            });
            if (landed.status !== "ok") return refused(`the write of ${outputPath} was refused (${landed.status})`);

            const record: DerivationRecord = {
                outputPath,
                outputHash: computeSha256(landed.bytes),
                sources,
                scriptHash: computeSha256(Buffer.from(ctx.script.code, "utf8")),
                script: ctx.script.code,
                toolCallId: ctx.invocationId,
            };
            const appended = await deps.derivations.appendDerivation(threadId, record);
            if (appended.isErr()) {
                logger.error("the derivation record did not land", { threadId, ...logger.errorFields(appended.error.cause) });
                return err({ error: "the derivation record did not land, thus the table is not evidence of this session", retryable: true });
            }
            if (appended.value === "duplicate") return refused(`another turn recorded ${outputPath} first, thus this table takes a new name`);
            if (appended.value === "absent") return refused("no report session state row exists to hold the derivation");
            observeDerived(analysisId, threadId, record);
            await syncWrittenFile(deps.syncSessionFile, logger, {
                session: ctx.session,
                owner: { kind: "thread", threadId },
                path: outputPath,
                hash: record.outputHash,
                size: landed.bytes.length,
                content: landed.bytes,
            });
            return ok(derivedOutput(record, landed.bytes.length, columns));
        },
    });
}

/** The script tools of a report session. */
export function createReportScriptTools(deps: ReportScriptToolsDeps): Tool[] {
    return [createReadTableTool(deps), createWriteDerivedTool(deps)];
}
