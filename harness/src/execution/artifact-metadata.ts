/**
 * Per-step artifact metadata generation — describes a step's output files
 * through a continuation of the step agent's conversation (`continueAgent`)
 * on the harness `ChatProvider`.
 *
 * The continuation extends the prefix that the task cached, so each signed
 * thinking block of the task must stay valid across the extension.
 *
 * Descriptions match files BY PATH, not by array index, so a dropped,
 * reordered, or extra entry can never attach to the wrong file.
 *
 * Lossless contract: every input artifact appears in the result exactly
 * once. A file the model never describes gets a deterministic fallback
 * description, logged, never silently dropped.
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
     * The transcript from `runAgent` that the continuation extends, to
     * ground each file's description in why the step produced it.
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
    /** The continuation's new messages: the request, then its replies. Empty when no continuation ran. */
    readonly messages: readonly LoopMessage[];
}

const DESCRIBER_AGENT_ID = "file-metadata-describer";

/** Request cap: one submission plus a few correction rounds; an exhausted cap falls back safely. */
const DESCRIBER_MAX_REQUESTS = 8;

/** Tool ids the continuation's mask allows; each must be a tool the step agent already declares. */
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

/** Describes a step's known artifacts; a continuation failure degrades to per-file fallbacks rather than throwing. */
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
