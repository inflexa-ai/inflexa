/**
 * Per-step artifact metadata generation — describes a step's output files
 * via a focused `runAgent` tool-call loop on the harness `ChatProvider`.
 *
 * Design (mirrors `generate-plan.ts`): the describer agent communicates
 * exclusively through one tool, `submit_file_metadata`, whose `execute`
 * validates every entry's `path` against the known artifact set. Unknown
 * paths (hallucinated files) are rejected with feedback; uncovered files are
 * reported as `remaining` so the model resubmits. Descriptions are matched
 * to files BY PATH — there is no positional array-index alignment, so a
 * dropped, reordered, or extra entry can never attach a description to the
 * wrong file.
 *
 * Lossless contract: every input artifact appears in the result exactly
 * once. A file the model never describes (loop budget exhausted, persistent
 * tool errors, model refusal) gets a deterministic fallback description
 * synthesised from its path + inferred type + size. Fallbacks are logged —
 * never silently dropped, never silently chunked out.
 *
 * `Session` is taken explicitly (see the harness-durable-runtime spec) — billing is a compile-time
 * obligation on every provider call.
 */

import { ok } from "neverthrow";

import type { AgentSession } from "../auth/types.js";
import { forSubAgent } from "../auth/types.js";
import { runAgent } from "../loop/run-agent.js";
import { passthroughStep } from "../loop/run-step.js";
import type { AgentDefinition, LoopMessage } from "../loop/types.js";
import type { AgentChat } from "../providers/types.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { createReadFileTool } from "../tools/workspace/read-file.js";
import { composeSystemPrompt } from "../agents/system-prompt.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import { inferArtifactType } from "../schemas/artifact-manifest.js";
import { SubmitFileMetadataInputSchema, type SubmittedFileDescription } from "../schemas/file-metadata.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";

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
    readonly provider: AgentChat;
    readonly session: AgentSession;
    readonly artifacts: readonly ArtifactForMetadata[];
    readonly resourceId: string;
    /** Extra metadata fields merged into every entry's `metadata`. */
    readonly extraMetadata?: Record<string, unknown>;
    /** Model id — provenance label only; the provider owns the wire model. */
    readonly modelId: string;
    /**
     * In-memory step transcript from `runAgent` — gives the describer the
     * agent's intent so descriptions reflect what the file was produced for.
     * Optional: empty/absent degrades to path-only describing.
     */
    readonly messages?: readonly LoopMessage[];
    /** Workspace read seam — backs the scoped `read_file` tool. */
    readonly workspaceFs?: WorkspaceFilesystem;
    /** Absolute host path to the step's writable output tree — `read_file`'s working dir. */
    readonly workingDir?: string;
    /** Iteration budget for the describer loop. Defaults to {@link DEFAULT_MAX_ITERATIONS}. */
    readonly maxIterations?: number;
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
}

/** Sub-agent identity for the describer loop — provenance only. */
const DESCRIBER_AGENT_ID = "file-metadata-describer";

/**
 * Iteration budget: one full submission + a few correction rounds. The
 * fallback backstop means an exhausted budget degrades gracefully rather
 * than dropping files, so the cap stays small.
 */
const DEFAULT_MAX_ITERATIONS = 8;

const SYSTEM_PROMPT = `You are a deterministic metadata describer for bioinformatics output files.

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

function buildPrompt(artifacts: readonly ArtifactForMetadata[]): string {
    const list = artifacts.map((a) => `- ${a.displayPath}`).join("\n");
    return `Describe the following output files by calling submit_file_metadata. Copy each \`path\` EXACTLY from this list. Read a file with read_file when its path alone is not enough to describe it accurately:\n\n${list}`;
}

/**
 * Drop a trailing partial assistant `tool_use` round from a loop transcript:
 * it has no matching `tool_result`, so prefixing it onto a fresh loop turn
 * would be an invalid message sequence.
 */
function sanitizeTranscript(messages: readonly LoopMessage[]): LoopMessage[] {
    const out: LoopMessage[] = [...messages];
    while (out.length > 0) {
        const last = out[out.length - 1]!;
        const blocks = Array.isArray(last.content) ? last.content : [];
        const hasOpenToolUse = last.role === "assistant" && blocks.some((b) => b.type === "tool-call");
        if (hasOpenToolUse) {
            out.pop();
            continue;
        }
        break;
    }
    return out;
}

/**
 * The single describer tool. Accumulates accepted descriptions into
 * `holder` keyed by path; rejects paths outside `knownPaths`. Returns the
 * coverage state the model uses to decide whether to continue.
 */
function buildSubmitTool(holder: Map<string, SubmittedFileDescription>, knownPaths: ReadonlySet<string>): Tool {
    return defineTool({
        id: "submit_file_metadata",
        description:
            "Submit metadata for output files. Each entry's `path` MUST exactly " +
            "match one of the listed files. Returns {accepted, unknownPaths, " +
            "remaining}: accepted=true means every file now has metadata — STOP. " +
            "Otherwise drop the unknownPaths and describe the remaining files.",
        inputSchema: SubmitFileMetadataInputSchema,
        execute: async (input) => {
            const unknownPaths: string[] = [];
            for (const entry of input.files) {
                if (!knownPaths.has(entry.path)) {
                    unknownPaths.push(entry.path);
                    continue;
                }
                holder.set(entry.path, entry);
            }
            const remaining = [...knownPaths].filter((p) => !holder.has(p));
            return ok({
                accepted: unknownPaths.length === 0 && remaining.length === 0,
                unknownPaths,
                remaining,
            });
        },
    });
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
 * Describe a step's known artifacts via a tool-call loop. Non-fatal: a loop
 * failure or partial coverage degrades to deterministic fallbacks, so the
 * result always carries exactly one entry per input artifact.
 */
export async function generateFileMetadata(opts: GenerateFileMetadataOptions): Promise<FileMetadataResult> {
    const logger = (opts.logger ?? createNoopLogger()).named("artifact-metadata").with({ resourceId: opts.resourceId });
    if (opts.artifacts.length === 0) {
        return { indexed: 0, entries: [] };
    }

    const knownPaths = new Set(opts.artifacts.map((a) => a.displayPath));
    const holder = new Map<string, SubmittedFileDescription>();

    const tools: Tool[] = [buildSubmitTool(holder, knownPaths)];
    if (opts.workspaceFs) {
        tools.push(createReadFileTool(opts.workspaceFs, opts.workingDir));
    }

    const describer: AgentDefinition = {
        id: DESCRIBER_AGENT_ID,
        systemPrompt: composeSystemPrompt(SYSTEM_PROMPT),
        model: opts.modelId,
        tools,
        maxIterations: opts.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    };

    const abortController = opts.signal ? undefined : new AbortController();
    const signal = abortController ? abortController.signal : opts.signal;

    const transcript = opts.messages ? sanitizeTranscript(opts.messages) : [];

    try {
        await runAgent(describer, [...transcript, { role: "user", content: buildPrompt(opts.artifacts) }], forSubAgent(opts.session, DESCRIBER_AGENT_ID), {
            provider: opts.provider,
            signal,
            emit: () => {},
            runStep: passthroughStep,
        });
    } catch (err) {
        logger.warn("describer loop failed; using fallbacks", logger.errorFields(err));
    } finally {
        abortController?.abort();
    }

    const entries: FileMetadataEntry[] = [];
    const fallbackPaths: string[] = [];
    for (const artifact of opts.artifacts) {
        const desc = holder.get(artifact.displayPath);
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

    return { indexed: holder.size, entries };
}
