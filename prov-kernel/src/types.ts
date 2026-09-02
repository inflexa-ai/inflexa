/**
 * The provenance domain model: the kinds of tracked actions, the agent responsible for one, and
 * the ref/value types the document builders (`document.ts`) accept. An analysis's provenance is a
 * W3C PROV document (serialized as PROV-JSON), built incrementally by a host-owned recorder from
 * these values. The event vocabulary a recorder consumes is deliberately NOT here — each host owns
 * its own event set; the kernel owns only the representation those events append.
 */

/**
 * The resolved responsible agent for an action — a discriminated union so the call site states
 * *which* kind it is recording, and so the document builder reads the right fields per kind.
 * `user` is a logged-in person, `anonymous` an unauthenticated person, `system` the embedding
 * host acting autonomously — it carries the host's own identity (label, version, and the source
 * commit when the host has one), so a CLI records itself and a managed service records itself.
 */
export type ProvActor =
    | {
          kind: "user";
          /**
           * The opaque stable identifier of the person; the user-agent QName derives from it.
           * Documents are immutable and signed, thus the identity-bearing key must never be
           * personal data that can change or that a writer must withhold.
           */
          id: string;
          /** The person's email, when the host chooses to include personal data as an attribute. */
          email?: string;
      }
    | { kind: "anonymous" }
    | {
          kind: "system";
          /** The host software's human name (e.g. "inflexa cli", "cortex"). */
          label: string;
          /** The host's package/build version. */
          version: string;
          /** The exact source commit, when the host knows it. */
          commit?: string;
      };

/**
 * The LLM that reasoned about a model-driven activity — recorded as its own PROV `SoftwareAgent`
 * (typed `inflexa:Model`) that `actedOnBehalfOf` the responsible agent, so the document answers
 * *which intelligence entered the process*, not just that the host acted.
 *
 * The vendor-qualified `{provider}/{model}` name (e.g. `anthropic/claude-opus-4-8`). The model
 * part is always the RESOLVED id; the provider part is an OPEN vocabulary recorded verbatim.
 * NEVER carries API keys, credentialed URLs, or prompt content — the model's identity is the
 * whole record.
 */
export type ProvModelId = `${string}/${string}`;

/**
 * The subject an analysis document is seeded from — the identity fields written onto the
 * analysis's PROV subject entity. `name`/`slug` are attributes when the host has them; the id
 * alone suffices.
 */
export type ProvSubject = {
    analysisId: string;
    name?: string;
    slug?: string;
};

/**
 * The subset of an analysis input that provenance records: the identity fields for the PROV
 * entity (stable QName from anchor+path) and the attributes written onto it.
 */
export type ProvInputRef = {
    path: string;
    isDir: boolean;
    anchorId: string | null;
};

/**
 * A workflow run at its start. Recorded as a PROV **activity**.
 */
export type ProvRunRef = {
    /** The run's identity; the deterministic run-activity QName derives from it. */
    runId: string;
    /** The plan summary for this run, when the host supplies one. */
    planSummary?: string;
    /**
     * Epoch-ms the host observed the run start, read from a replay-stable clock (e.g. DBOS's
     * checkpointed `DBOS.now()`) — the same value across every durable replay, NOT a receipt
     * time. Builders convert it to the run activity's formal `prov:startTime`, so the recorded
     * start is the true workflow boundary even when the flush-surviving observation happens on a
     * later recovery boot.
     */
    startedAtMs: number;
};

/**
 * The terminal outcome of a workflow run. Recorded as the run activity's end time and outcome
 * status.
 */
export type ProvRunOutcome = {
    /** Identifies the run whose activity this completion closes — matches the run-start `runId`. */
    runId: string;
    /**
     * The host's terminal run status. A budget pause records as `"canceled"` — so
     * `"suspended_insufficient_funds"` is never emitted and is deliberately absent here.
     */
    status: "completed" | "partial" | "failed" | "canceled";
    /** Epoch-ms the host observed the run terminate, from a replay-stable clock. */
    completedAtMs: number;
    /** Host-observed run duration (terminal minus start replay-stable clock reads). */
    durationMs?: number;
};

/**
 * A pure reference to a workflow step within a run — the identity a file generation or an input
 * read edges to. Settlement facts (status, times, duration) live on {@link ProvStepOutcome}, not
 * here — this is deliberately just the `(runId, stepId)` key so a file/input edge never carries
 * stale lifecycle data.
 */
export type ProvStepRef = {
    /** The owning run — the step activity is `wasInformedBy` this run's activity. */
    runId: string;
    /** The step's identity within its run; the step-activity QName derives from `(runId, stepId)`. */
    stepId: string;
};

/**
 * The settlement outcome of a workflow step. Emitted at the host scheduler settlement (the only
 * site that observes every executed step — including zero-artifact and failed ones), never at
 * artifact registration.
 */
export type ProvStepOutcome = {
    /** The owning run — the step activity is `wasInformedBy` this run's activity. */
    runId: string;
    /** The step's identity within its run; the step-activity QName derives from `(runId, stepId)`. */
    stepId: string;
    /** The settlement outcome mapped to a terminal step status. */
    status: "completed" | "failed" | "canceled";
    /** Epoch-ms the host observed the step settle, from a replay-stable clock. */
    completedAtMs: number;
    /** The child's durable execution duration, when the settlement carried one. */
    durationMs?: number;
};

/**
 * A file a step READ — an attested input consumed during execution. Recorded as a PROV **entity**
 * in the SAME `(path, hash)` QName space as {@link ProvFileRef} outputs, so a `source: "prior"`
 * read of an earlier run's output resolves to the very entity that run's file write generated
 * (cross-run lineage merges for free under `unified()`).
 */
export type ProvUsedInputRef = {
    /** Analysis-relative path (container mount prefix stripped); with `hash`, seeds the shared file QName. */
    path: string;
    /** Content hash attested from disk — the other half of the deterministic file QName. */
    hash: string;
    /** The read-classification, minus the step's own `"artifacts"` outputs. */
    source: "data" | "upstream" | "prior";
    /** The staged-input file id, when one was resolved. */
    fileId?: string;
};

/**
 * A file produced under the analysis output tree — a sandbox command output or an agent file-tool
 * write. Recorded as a PROV **entity** generated by its step or producing command.
 */
export type ProvFileRef = {
    /** Analysis-scoped path (`runs/{runId}/{stepId}/…`); with the hash, seeds the file QName. */
    path: string;
    /** Content hash captured at write time — the other half of the deterministic file QName. */
    hash: string;
    /** File size in bytes. */
    size: number;
    /** How the bytes came to exist, in the collector's bare `Producer.type` vocabulary. */
    producer: "command" | "file_tool";
};

/**
 * The `(path, hash)` identity pick of {@link ProvFileRef} — the QName key space every file entity
 * lives in. Named (not an inline `Pick`) so the shared key space reads as one type at every use
 * site.
 */
export type ProvFileKey = Pick<ProvFileRef, "path" | "hash">;

/**
 * A file a COMMAND read — the command-scoped analogue of {@link ProvUsedInputRef}. It widens the
 * used-input source vocabulary with `"step"`: a resolved intra-step self-read (command B reading
 * command A's output within one step) — a chain edge the step-level vocabulary never carries,
 * because at STEP scope "the step read its own output" is noise, while at COMMAND scope it is
 * exactly the intra-step lineage signal.
 */
export type ProvCommandInputRef = {
    /** Analysis-relative path; with `hash`, keys the shared file QName. */
    path: string;
    /** Content hash attested from disk. */
    hash: string;
    /** The read classification, plus `"step"` for a resolved intra-step self-read. */
    source: "data" | "upstream" | "prior" | "step";
    /** The staged-input file id, when one was resolved. */
    fileId?: string;
};

/**
 * One command execution inside a step that produced files. Records as a PROV **activity** typed
 * `inflexa:Command`. One ref per surviving producer group: the collector is last-write-wins per
 * output path, so after collapse a group is uniquely keyed by its OUTPUT SET (never the producer's
 * object identity, which is meaningless across a durable workflow re-execution). The `kind`
 * discriminator literal stays on the single remaining variant for wire stability.
 *
 * NO timestamp field by design: the producer's observation timestamp is re-minted on every durable
 * replay (replay-unstable), so it must never cross into an identifier or a formal PROV position.
 * The command activity therefore carries no formal start/end time at all — its ordering lives on
 * the `wasInformedBy` edge to its step, and the step carries replay-stable settlement times.
 */
export type ProvCommandRef = {
    kind: "command";
    /** The command line the sandbox executed. */
    command: string;
    /** The command's argument vector, when the collector captured one. */
    args?: string[];
    /** The process exit code. */
    exitCode: number;
    /** Execution duration in ms, when captured — a relative span (replay-stable), NOT an observation timestamp. */
    durationMs?: number;
    /** The script the command ran, when it read one; resolved against the group's own outputs/inputs by the builder. */
    scriptPath?: string;
    /** The files this command wrote — its generation authority; each keys a file entity. */
    outputs: ProvFileKey[];
    /** The command's command-scoped reads: data/upstream/prior reads plus resolved intra-step self-reads. */
    inputs: ProvCommandInputRef[];
};

/**
 * One file-tool invocation (`write_file` / `edit_file`) that wrote a file — the generation
 * authority a `file_written` event with `generation: "call"` anchors to. Records as a
 * DETERMINISTIC PROV **activity** typed `inflexa:FileToolWrite`, keyed by the invocation id plus a
 * scope disambiguator: `invocationId` is replay-stable (the durably cached model turn minted it)
 * but unique per agent loop only, so the QName mixes in the step key when the write is
 * step-scoped, else the thread.
 */
export type ProvCallRef = {
    /** The loop's tool-call id — replay-stable, unique within one agent loop only. */
    invocationId: string;
    /** The agent file-tool that authored the content (e.g. `write_file`), an OPEN vocabulary. */
    tool: string;
    /** The thread of the session that wrote the file. Absent when the host scoped no thread. */
    threadId?: string;
};

/**
 * A started agent session of an analysis. One shape carries both kinds, because to start a session
 * is one action and the kind is data of that action. Recorded as a PROV **activity**; a `report`
 * session also mints the report entity every later act operates on.
 */
export type ProvSessionRef = {
    /** The thread that identifies the session — the key every later report act names. */
    threadId: string;
    /** A `report` session owns a report document; a `conversation` is the session alone. */
    kind: "conversation" | "report";
    /** The thread the session was started from. Absent on a root session. */
    parentThreadId?: string;
};

/**
 * One block operation on a report document — the payload of the four block acts (add, change,
 * remove, move), which share this shape because they differ only in what they did.
 */
export type ProvReportBlockRef = {
    /** The report session that holds the block. */
    threadId: string;
    /** The block the act added, changed, removed, or moved. */
    blockId: string;
    /**
     * The kind of the block after the act, recorded verbatim as an OPEN vocabulary: the kernel
     * carries the value into the document and owns no block grammar, thus a host can record a new
     * kind with no kernel change.
     */
    blockKind: string;
};

/** A title set on a report document. The title sits on the document, thus it names no block. */
export type ProvReportTitleRef = {
    /** The report session whose document carries the title. */
    threadId: string;
    /** The title text the act set. */
    title: string;
};

/** One `(path, content hash)` input of a derivation — the evidence a verifier mounts to make the derived file again. */
export type ProvReportDerivationSourceRef = {
    /** The path of the source file, relative to the workspace root. */
    path: string;
    /** The content hash of the source at derivation time. */
    hash: string;
};

/**
 * A derivation a report session ran. The source chain rides the ref because the emitting host pins
 * it, and a reader cannot rebuild it from the output path alone — one path can be derived again
 * from different sources.
 */
export type ProvReportDerivationRef = {
    /** The report session that ran the derivation. */
    threadId: string;
    /** The path of the derived file, relative to the workspace root. A record is immutable, thus a new derivation takes a new path. */
    outputPath: string;
    /** The content hash of the derived file. */
    outputHash: string;
    /** The content hash of the script that produced the derived file. */
    scriptHash: string;
    /** Every source the derivation read, each as a `(path, hash)` pair. */
    sources: readonly ProvReportDerivationSourceRef[];
};

/** A rendered preview of a report document. */
export type ProvReportPreviewRef = {
    /** The report session whose document the page shows. */
    threadId: string;
    /** The path of the rendered page, relative to the workspace root. */
    pagePath: string;
    /** The hash of the draft document the page was rendered from, thus a reader ties a page to its source. */
    documentHash: string;
};

/**
 * A recorded version of a report. Recorded as a PROV **entity** that is a `specializationOf` the
 * report entity — the report, fixed at one point in time.
 */
export type ProvReportVersionRef = {
    /** The report session the version was recorded from. */
    threadId: string;
    /** The version the act recorded. */
    versionId: string;
    /** True when the record superseded an earlier version of the same session. */
    replaced: boolean;
};

/**
 * The outcome of a provenance verification: one of several mutually exclusive states, each with
 * enough detail for a host to render a clear message.
 */
export type VerifyResult =
    | { status: "valid" }
    | { status: "unsigned" }
    | { status: "tampered"; detail: string }
    | { status: "no-key" }
    | { status: "empty" }
    | { status: "invalid-attestation"; detail: string }
    | { status: "invalid-key" }
    | { status: "verify-error"; detail: string };
