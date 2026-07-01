/**
 * Unified provenance types for tracking artifact lineage.
 *
 * Each output artifact gets a ProvenanceRecord that captures:
 *   - What produced it (file tool write or sandbox command)
 *   - What inputs it consumed (lineage chain)
 *   - What script generated it (if any)
 */

import { z } from "zod";

// ── Producer ────────────────────────────────────────────────────────

/** File tool write (write_file, append_file, copy_file). */
export const FileToolProducerSchema = z.object({
    type: z.literal("file_tool"),
    tool: z.string(),
    timestamp: z.string(),
});

/** Sandbox command execution (execute_command). */
export const CommandProducerSchema = z.object({
    type: z.literal("command"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    exitCode: z.number(),
    durationMs: z.number(),
    timestamp: z.string(),
});

export const ProducerSchema = z.discriminatedUnion("type", [FileToolProducerSchema, CommandProducerSchema]);
export type Producer = z.infer<typeof ProducerSchema>;

// ── InputRef ────────────────────────────────────────────────────────

/** Classification of an input source based on mount semantics. */
export const InputSourceSchema = z.enum(["data", "upstream", "prior", "artifacts"]);
export type InputSource = z.infer<typeof InputSourceSchema>;

/** A single input reference in a lineage chain. */
export const InputRefSchema = z.object({
    /** Mount-relative path: /data/counts.csv, /upstream/de/output/results.csv */
    path: z.string(),
    /** SHA-256 hash at read time. */
    hash: z.string(),
    /** Source classification derived from mount path. */
    source: InputSourceSchema,
    /** Step ID that produced this input (absent for data inputs). */
    stepId: z.string().optional(),
    /** Run ID that produced this input (absent for data inputs). */
    runId: z.string().optional(),
    /** S3 file identity for input files (source: "data"). */
    fileId: z.string().optional(),
});
export type InputRef = z.infer<typeof InputRefSchema>;

// ── ProvenanceRecord ────────────────────────────────────────────────

/** Provenance record for a single output artifact. */
export const ProvenanceRecordSchema = z.object({
    /** Path relative to /artifacts. */
    outputPath: z.string(),
    /** SHA-256 hash of the output. */
    outputHash: z.string(),
    /** Size in bytes. */
    outputSize: z.number(),
    /** How this artifact was produced. */
    producer: ProducerSchema,
    /** Input files consumed to produce this artifact. */
    inputs: z.array(InputRefSchema),
    /** Path to the script that produced this, if identifiable. */
    scriptPath: z.string().nullable(),
    /** Workflow step that produced this artifact. */
    stepId: z.string(),
    /** Workflow run ID. */
    runId: z.string(),
});
export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;
