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

/** A setting value of a template render: a scalar, or a list of strings. */
const TemplateSettingValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

/**
 * The facts of one template render: which template, from which release, with which settings. The write of the
 * rendered script carries them, thus the script version that the render wrote names its template.
 */
export const TemplateRenderSchema = z.object({
    /** The template id with its version, for example `tpl-deseq2-two-group@1.0.0`. */
    template: z.string(),
    label: z.string(),
    method: z.object({ id: z.string(), label: z.string() }),
    /** The snapshot digest of the release that served the render. Absent for a template source with no releases. */
    snapshot: z.string().optional(),
    /** Each setting that the script reads, with its value, where the value came from (the plan, a default, the agent), and the 1-based lines of the script that carry it. */
    settings: z.array(z.object({ name: z.string(), value: TemplateSettingValueSchema.optional(), source: z.string(), lines: z.array(z.number()).optional() })),
    /** Each plan value that the agent changed, with the reason. */
    overrides: z.array(z.object({ slot: z.string(), reason: z.string() })),
    /** How the installed packages matched the pins of the template. */
    environmentMatch: z.string(),
});
export type TemplateRender = z.infer<typeof TemplateRenderSchema>;

/**
 * File tool write (write_file, edit_file, run_template). Carries the loop's tool-call
 * `invocationId` — replay-stable, and the identity the bridge mixes into the
 * deterministic call-activity QName — instead of a wall-clock timestamp,
 * which would be re-minted on every durable replay.
 */
export const FileToolProducerSchema = z.object({
    type: z.literal("file_tool"),
    tool: z.string(),
    invocationId: z.string(),
    /** Present on the write of a rendered template script. */
    template: TemplateRenderSchema.optional(),
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
    /** Analysis-relative path of the script that produced this, or null when the command named no script in the analysis. */
    scriptPath: z.string().nullable(),
    /** Workflow step that produced this artifact. */
    stepId: z.string(),
    /** Workflow run ID. */
    runId: z.string(),
});
export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;
