/**
 * Per-shape header readout.
 *
 * Split by what the readout needs. A header that sits at the front of the file —
 * magic bytes, a `##` preamble, a delimited header row, a compressed prefix — is
 * reachable from a bounded read, so it runs in this process over the workspace read
 * seam (see `readout.ts`) and costs no sandbox round trip.
 *
 * A container that indexes its contents from a footer cannot be read that way, and
 * running a container parser over user-supplied bytes in a long-lived multi-tenant
 * process is the exposure the ephemeral sandbox exists to contain. Those readouts run
 * from `decoder/container_readout.py`, a package asset delivered on the command line
 * through the existing `runSandboxExec` path.
 *
 * Cost is O(shapes), not O(files): shapes are observed from names and sizes alone, so
 * enrichment reads a bounded number of members per shape whatever the tree's size.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";

import type { AgentSession } from "../auth/types.js";
import type { EmitFn } from "../tools/define-tool.js";
import type { SandboxClient } from "../sandbox/client.js";
import type { SandboxRef } from "../sandbox/types.js";
import { runSandboxExec } from "../tools/workspace/run-exec.js";
import type { ExecResult } from "../sandbox/types.js";
import type { ReadBytesResult, WorkspaceFilesystem } from "../workspace/filesystem.js";

import { READOUT_PREFIX_BYTES, readPrefix } from "./readout.js";
import { safeParseJsonAs } from "../lib/parse-json.js";
import { presentAt } from "../lib/present.js";
import { collapseWhitespace } from "../lib/text.js";
import type { FileShape, HeaderReadout } from "./types.js";

/** Members decoded per shape. One is enough to characterise a set whose names already match. */
export const MEMBERS_DECODED_PER_SHAPE = 1;

/** Wall-clock bound on the container-decode exec. It opens footers, nothing more. */
const ENRICH_TIMEOUT_SECONDS = 120;

/**
 * Prefix reads in flight at once. Each is a bounded read over the workspace seam; running
 * them one at a time makes a menu of sixty leftovers sixty serial round trips, and running
 * them all at once hands the seam an unbounded burst.
 */
export const READOUT_CONCURRENCY = 8;

/** Characters of decoder stderr carried into a per-file reason. */
const MAX_STDERR_CHARS = 160;

/**
 * The formats whose header lives behind a whole-container parse: Parquet's schema is
 * in its footer, the HDF5 families index objects across the file, and PDF and DOCX
 * both resolve their contents through a trailer. Everything else reads from a prefix.
 */
export const SANDBOX_CONTAINER_FORMATS: ReadonlySet<string> = new Set(["parquet", "hdf5", "h5ad", "loom", "pdf", "docx"]);

const CONTAINER_DECODER = new URL("./decoder/container_readout.py", import.meta.url);

/** One file to read a header from, and what the scan already knows about its bytes. */
export type ReadoutTargetSpec = {
    readonly path: string;
    readonly format: string;
    readonly wrapper?: string;
};

export type ReadHeadersArgs = {
    readonly targets: readonly ReadoutTargetSpec[];
    readonly session: AgentSession;
    readonly fs: WorkspaceFilesystem;
    /** Omit the sandbox to skip container readouts; every other format still reads. */
    readonly sandboxClient?: SandboxClient;
    readonly sandbox?: SandboxRef;
    /** Absolute in-sandbox path of the analysis root (`/{analysisId}`). */
    readonly mountRoot: string;
    readonly deadlineMs: number;
    readonly emit: EmitFn;
};

export type EnrichShapesArgs = {
    readonly shapes: readonly FileShape[];
    readonly session: AgentSession;
    readonly fs: WorkspaceFilesystem;
    /** Omit the sandbox to skip container readouts; every other format still reads. */
    readonly sandboxClient?: SandboxClient;
    readonly sandbox?: SandboxRef;
    /** Absolute in-sandbox path of the analysis root (`/{analysisId}`). */
    readonly mountRoot: string;
    readonly deadlineMs: number;
    readonly emit: EmitFn;
};

/**
 * Read a header from each named file, keyed by path.
 *
 * A target whose readout failed carries an `unavailable` note rather than vanishing: the
 * readout is enrichment, and a menu without it still carries every structural observation
 * the agent's grouping rests on.
 */
export async function readHeaders(args: ReadHeadersArgs): Promise<Map<string, HeaderReadout>> {
    const readouts = new Map<string, HeaderReadout>();
    const containers: ReadoutTargetSpec[] = [];
    const prefixed: ReadoutTargetSpec[] = [];
    for (const target of args.targets) {
        if (SANDBOX_CONTAINER_FORMATS.has(target.format)) containers.push(target);
        else prefixed.push(target);
    }

    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(READOUT_CONCURRENCY, prefixed.length) }, async () => {
            for (let i = next++; i < prefixed.length; i = next++) {
                const target = presentAt(prefixed, i, "readout targets");
                readouts.set(target.path, await readFromPrefix(args, target));
            }
        }),
    );

    const { sandboxClient, sandbox } = args;
    if (containers.length > 0 && sandboxClient && sandbox) {
        for (const [path, readout] of await decodeContainers(args, { sandboxClient, sandbox }, containers)) readouts.set(path, readout);
    }
    return readouts;
}

/**
 * Read one member per shape and attach the readout.
 *
 * A shape whose readout failed keeps its `unavailable` note rather than losing the
 * shape, for the same reason.
 */
export async function enrichShapes(args: EnrichShapesArgs): Promise<FileShape[]> {
    const targets = new Map<string, FileShape>();
    for (const shape of args.shapes) {
        const path = shape.examplePaths.slice(0, MEMBERS_DECODED_PER_SHAPE)[0];
        if (path !== undefined && !targets.has(path)) targets.set(path, shape);
    }
    if (targets.size === 0) return [...args.shapes];

    const readouts = await readHeaders({
        ...args,
        targets: [...targets.entries()].map(([path, shape]) => ({ path, format: shape.format, wrapper: shape.wrapper })),
    });

    const byShape = new Map<string, HeaderReadout>();
    for (const [path, shape] of targets) {
        const readout = readouts.get(path);
        if (readout) byShape.set(shape.id, readout);
    }

    return args.shapes.map((shape) => {
        const header = byShape.get(shape.id);
        return header ? { ...shape, header } : shape;
    });
}

async function readFromPrefix(args: ReadHeadersArgs, target: ReadoutTargetSpec): Promise<HeaderReadout> {
    const { path } = target;
    const read = await args.fs
        .readBytes({ session: args.session, path, length: READOUT_PREFIX_BYTES })
        .unwrapOr<ReadBytesResult | { readonly kind: "read_failed" }>({ kind: "read_failed" });
    if (read.kind !== "ok") return { path, fields: {}, unavailable: `prefix unreadable (${read.kind})` };

    const readout = await readPrefix({ prefix: read.bytes, format: target.format, wrapper: target.wrapper });
    return { path, fields: readout.fields, unavailable: readout.unavailable };
}

/** One JSON line the decoder prints on stdout: the path it read, its fields, or why it could not. */
const ReadoutLineSchema = z.object({
    path: z.string().optional(),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    unavailable: z.string().optional(),
});

async function decodeContainers(
    args: ReadHeadersArgs,
    machine: { readonly sandboxClient: SandboxClient; readonly sandbox: SandboxRef },
    containers: readonly ReadoutTargetSpec[],
): Promise<Map<string, HeaderReadout>> {
    const readouts = new Map<string, HeaderReadout>();
    const source = await readFile(CONTAINER_DECODER, "utf8").catch(() => undefined);
    if (source === undefined) {
        for (const { path } of containers) readouts.set(path, { path, fields: {}, unavailable: "container decoder is missing from this build" });
        return readouts;
    }

    const byAbsolute = new Map<string, ReadoutTargetSpec>();
    for (const target of containers) byAbsolute.set(`${args.mountRoot}/${target.path}`, target);

    const result = await runSandboxExec({
        sandboxClient: machine.sandboxClient,
        sandbox: machine.sandbox,
        command: ["python3", "-c", source, ...byAbsolute.keys()],
        timeoutSeconds: ENRICH_TIMEOUT_SECONDS,
        deadlineMs: args.deadlineMs,
        emit: args.emit,
    });

    for (const line of result.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let parsed: z.ZodSafeParseResult<z.infer<typeof ReadoutLineSchema>>;
        try {
            parsed = safeParseJsonAs(trimmed, ReadoutLineSchema);
        } catch {
            // The sandbox caps stdout and a timeout can stop the decoder mid-write, so the last line can be cut.
            continue;
        }
        if (!parsed.success) continue;
        const target = parsed.data.path ? byAbsolute.get(parsed.data.path) : undefined;
        if (!target) continue;
        readouts.set(target.path, {
            path: target.path,
            fields: parsed.data.fields ?? {},
            unavailable: parsed.data.unavailable,
        });
    }

    // A target the decoder said nothing about is told WHY, from the exec's own outcome: the
    // decoder reports per path and exits 0 even when every path failed, so a silent gap is
    // the exec itself having timed out, died, or never started — and "reported nothing" on
    // its own is the one thing a reader cannot diagnose.
    const failure = describeExecFailure(result);
    for (const { path } of containers) {
        if (!readouts.has(path)) readouts.set(path, { path, fields: {}, unavailable: failure });
    }
    return readouts;
}

const CUT_OUTPUT_REASON = "container decoder output was cut at the sandbox byte cap";

function describeExecFailure(result: ExecResult): string {
    const cut = result.stdoutTruncated ? ` (${CUT_OUTPUT_REASON})` : "";
    if (result.timedOut) return `container decoder timed out after ${ENRICH_TIMEOUT_SECONDS}s${cut}`;
    if (result.syntheticFailure) return `container decoder did not complete: ${result.syntheticFailure.reason}${cut}`;
    if (result.exitCode !== 0) {
        const stderr = collapseWhitespace(result.stderr).slice(0, MAX_STDERR_CHARS);
        return `container decoder exited ${result.exitCode ?? "with no code"}${stderr ? `: ${stderr}` : ""}${cut}`;
    }
    if (result.stdoutTruncated) return CUT_OUTPUT_REASON;
    return "container decoder reported nothing for this member";
}
