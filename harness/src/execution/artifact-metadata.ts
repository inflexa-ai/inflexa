/**
 * Per-step artifact metadata generation — describes a step's output files
 * through a continuation of the conversation of the step agent
 * (`continueAgent`), on the harness `ChatProvider`.
 *
 * The continuation extends the prefix that the task cached: the same system
 * prompt, the same declared tools, the same tool choice, and each message of
 * the task. Thus it reads that prefix back from the prompt cache, and each
 * signed thinking block of the task stays valid. Its request gives the
 * describer instructions and the list of the files, and its mask lets only
 * `submit_file_metadata`, `read_file`, and `grep` run.
 *
 * The step agent declares `submit_file_metadata` from its first request
 * (`tools/sandbox/submit-file-metadata.ts`). The tool validates every entry's
 * `path` against the known artifact set that `cell.expect` sets. Unknown paths
 * (hallucinated files) are rejected with feedback; uncovered files are reported
 * as `remaining` so the model resubmits. Descriptions are matched to files BY
 * PATH — there is no positional array-index alignment, so a dropped,
 * reordered, or extra entry can never attach a description to the wrong file.
 *
 * Lossless contract: every input artifact appears in the result exactly
 * once. A file the model never describes (the cap exhausted, persistent tool
 * errors, model refusal) gets a deterministic fallback description
 * synthesised from its path + inferred type + size. Fallbacks are logged —
 * never silently dropped, never silently chunked out. A step agent that
 * declares no `submit_file_metadata` (an embedder that gives no cell to its
 * agent) gets the fallback for each file, with no model call.
 *
 * `Session` is taken explicitly (see the harness-durable-runtime spec) — billing is a compile-time
 * obligation on every provider call.
 */

import type { AgentSession } from "../auth/types.js";
import { continueAgent } from "../loop/continue-agent.js";
import { passthroughStep } from "../loop/run-step.js";
import type { AgentDefinition, LoopMessage } from "../loop/types.js";
import type { AgentChat } from "../providers/types.js";
import { inferArtifactType } from "../schemas/artifact-manifest.js";
import type { SubmittedFileDescription } from "../schemas/file-metadata.js";
import { SUBMIT_FILE_METADATA_TOOL_ID, type FileMetadataCell } from "../tools/sandbox/submit-file-metadata.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";

export interface ArtifactForMetadata {
    /** Path used to update `cortex_artifacts` after metadata generation. */
    readonly dbPath: string;
    /** Path shown to the model and used as the per-file key. */
    readonly displayPath: string;
    /** File size in bytes — surfaced in the deterministic fallback description. */
    readonly sizeBytes?: number;
}

export interface GenerateFileMetadataOptions {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    /** LLM usage-accounting seam for the continuation; omitted falls back to the no-op recorder. */
    readonly usageRecorder?: UsageRecorder;
    /** The provider of the task, thus each request extends the prefix that the task cached. */
    readonly provider: AgentChat;
    readonly session: AgentSession;
    readonly artifacts: readonly ArtifactForMetadata[];
    readonly resourceId: string;
    /** Extra metadata fields merged into every entry's `metadata`. */
    readonly extraMetadata?: Record<string, unknown>;
    /** The step agent: the continuation sends its system prompt and its declared tools. */
    readonly agent: AgentDefinition;
    /** The cell that the `submit_file_metadata` tool of `agent` records into. */
    readonly cell: FileMetadataCell;
    /**
     * The in-memory transcript of the task from `runAgent`: the conversation
     * that the continuation extends. It gives the agent the intent of each file.
     */
    readonly transcript: readonly LoopMessage[];
    readonly signal?: AbortSignal;
}

export interface FileMetadataEntry {
    readonly dbPath: string;
    readonly description: string;
    readonly metadata: Record<string, unknown>;
}

export interface FileMetadataResult {
    /** Number of files the model described — excludes deterministic fallbacks. */
    readonly indexed: number;
    /** One entry per input artifact (described or fallback), input order. */
    readonly entries: readonly FileMetadataEntry[];
    /**
     * The new messages of the continuation: the request, then each message
     * after it. Empty when no continuation ran.
     */
    readonly messages: readonly LoopMessage[];
}

/** The agent that the calls of the continuation are accounted under. */
const DESCRIBER_AGENT_ID = "file-metadata-describer";

/**
 * The cap of requests: one full submission + a few correction rounds. The
 * fallback backstop means an exhausted cap degrades gracefully rather than
 * dropping files, so the cap stays small.
 */
const DESCRIBER_MAX_REQUESTS = 8;

/** The tools that the continuation lets run. Each one is a declared tool of the step agent. */
const DESCRIBER_TOOLS = [SUBMIT_FILE_METADATA_TOOL_ID, "read_file", "grep"];

const DESCRIBER_INSTRUCTIONS = `Your work on this step has ended. Now describe its output files.

You describe files by calling the submit_file_metadata tool. For each file provide:
  - path        — copy the file's path EXACTLY from the list you are given.
  - description — one sentence describing what the file contains.
  - dataType    — semantic type (e.g. "count matrix", "QC report").
  - format      — file format (e.g. "csv", "tsv", "h5ad", "png").
  - rows, cols  — optional integers when known.
  - tags, warnings — optional string arrays.

Rules:
  - Only describe files from the provided list. Never invent a path.
  - Cover every file. You may submit in one call or several.
  - The tool returns {accepted, unknownPaths, remaining}. If accepted is true,
    every file is covered — STOP, do not call the tool again. Otherwise remove
    any unknownPaths (they are not real files) and describe the remaining files.
  - Prefer grounding descriptions in fact. Use the read_file tool to inspect a
    file's actual contents (e.g. a CSV header or a report's body) when the path
    alone is not enough to describe it accurately.
  - Do not guess file contents you cannot infer; a terse, honest description is
    better than a confident wrong one.`;

/** The harness request of the continuation: the describer instructions and the list of the files. */
function describerRequest(artifacts: readonly ArtifactForMetadata[]): string {
    const list = artifacts.map((a) => `- ${a.displayPath}`).join("\n");
    return `${DESCRIBER_INSTRUCTIONS}\n\nDescribe the following output files by calling submit_file_metadata. Copy each \`path\` EXACTLY from this list. Read a file with read_file when its path alone is not enough to describe it accurately:\n\n${list}`;
}

function buildEntry(artifact: ArtifactForMetadata, desc: SubmittedFileDescription, extra: Record<string, unknown> | undefined): FileMetadataEntry {
    const metadata: Record<string, unknown> = {
        ...extra,
        dataType: desc.dataType,
        format: desc.format,
    };
    if (desc.rows != null) metadata.rows = desc.rows;
    if (desc.cols != null) metadata.cols = desc.cols;
    if (desc.tags) metadata.tags = desc.tags;
    if (desc.warnings) metadata.warnings = desc.warnings;
    return { dbPath: artifact.dbPath, description: desc.description, metadata };
}

function fileExtension(displayPath: string): string {
    const base = displayPath.slice(displayPath.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : "unknown";
}

/**
 * Deterministic fallback for a file the model never described. No LLM call —
 * composed from facts already on disk so search still finds the file.
 */
function fallbackEntry(artifact: ArtifactForMetadata, extra: Record<string, unknown> | undefined): FileMetadataEntry {
    // Leading slash so `inferArtifactType` matches the `/figures/` etc. segment
    // on a working-directory-relative display path.
    const fileType = inferArtifactType(`/${artifact.displayPath}`);
    const format = fileExtension(artifact.displayPath);
    const sizePart = artifact.sizeBytes != null ? `, ${artifact.sizeBytes} bytes` : "";
    const description = `${artifact.displayPath} — ${fileType} file (${format}${sizePart}); automated description unavailable.`;
    return {
        dbPath: artifact.dbPath,
        description,
        metadata: { ...extra, dataType: fileType, format },
    };
}

/**
 * Describe a step's known artifacts through a continuation of the conversation
 * of the step agent. Non-fatal: a continuation failure or partial coverage
 * degrades to deterministic fallbacks, so the result always carries exactly
 * one entry per input artifact.
 */
export async function generateFileMetadata(opts: GenerateFileMetadataOptions): Promise<FileMetadataResult> {
    const logger = (opts.logger ?? createNoopLogger()).named("artifact-metadata").with({ resourceId: opts.resourceId });
    if (opts.artifacts.length === 0) {
        return { indexed: 0, entries: [], messages: [] };
    }

    // The mask can let only a declared tool run, and an embedder whose agent
    // factory gives no cell to the agent declares no output tool.
    if (!opts.agent.tools.some((tool) => tool.id === SUBMIT_FILE_METADATA_TOOL_ID)) {
        logger.warn("the step agent declares no submit_file_metadata, thus each file gets a deterministic fallback description", {
            agentId: opts.agent.id,
            artifactCount: opts.artifacts.length,
        });
        return { indexed: 0, entries: opts.artifacts.map((artifact) => fallbackEntry(artifact, opts.extraMetadata)), messages: [] };
    }

    opts.cell.expect(opts.artifacts.map((a) => a.displayPath));

    let messages: readonly LoopMessage[] = [];
    try {
        const continued = await continueAgent(
            opts.agent,
            opts.transcript,
            {
                text: describerRequest(opts.artifacts),
                mask: { allow: DESCRIBER_TOOLS },
                maxRequests: DESCRIBER_MAX_REQUESTS,
                stepNamespace: "file-metadata",
                accountingAgentId: DESCRIBER_AGENT_ID,
            },
            opts.session,
            {
                provider: opts.provider,
                signal: opts.signal ?? new AbortController().signal,
                emit: () => {},
                runStep: passthroughStep,
                usageRecorder: opts.usageRecorder,
            },
        );
        messages = continued.messages;
    } catch (err) {
        logger.warn("describer continuation failed; using fallbacks", logger.errorFields(err));
    }

    const entries: FileMetadataEntry[] = [];
    const fallbackPaths: string[] = [];
    for (const artifact of opts.artifacts) {
        const desc = opts.cell.descriptions.get(artifact.displayPath);
        if (desc) {
            entries.push(buildEntry(artifact, desc, opts.extraMetadata));
        } else {
            entries.push(fallbackEntry(artifact, opts.extraMetadata));
            fallbackPaths.push(artifact.displayPath);
        }
    }

    if (fallbackPaths.length > 0) {
        logger.warn("file(s) used a deterministic fallback description", {
            fallbackCount: fallbackPaths.length,
            artifactCount: opts.artifacts.length,
            fallbackPaths,
        });
    }

    return { indexed: entries.length - fallbackPaths.length, entries, messages };
}
