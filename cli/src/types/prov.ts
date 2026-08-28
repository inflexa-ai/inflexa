/**
 * The provenance domain model, re-exported from `@inflexa-ai/prov-kernel` — the kernel owns the
 * Inflexa PROV dialect (the value shapes, the statement builders, and the signed bytes they
 * produce); the cli owns only its recorder lifecycle and its bus contract. The bus members in
 * `events.ts` and every prov module consume these names from here, so the cli-facing import path
 * stays local while the shapes stay the kernel's.
 *
 * Two cli identity conventions ride on top of the kernel shapes (documents are immutable and
 * signed, so both are continuity-load-bearing for existing local documents):
 *
 * - `ProvActor` user: the cli passes `id` = the person's email — the value it historically keyed
 *   user agents by — and also passes `email`, so the derived `agent-user-…` QNames stay
 *   byte-identical on existing documents.
 * - `ProvActor` system: the cli passes `label: "inflexa cli"` and always a `commit`, matching the
 *   attributes its historical system agent carried.
 */
export type {
    ProvActor,
    ProvModelId,
    ProvInputRef,
    ProvRunRef,
    ProvRunOutcome,
    ProvStepRef,
    ProvStepOutcome,
    ProvUsedInputRef,
    ProvFileRef,
    ProvFileKey,
    ProvCommandInputRef,
    ProvCommandRef,
    VerifyResult,
} from "@inflexa-ai/prov-kernel";

// The report refs below are cli-owned, not kernel re-exports. The kernel dialect has no report
// vocabulary: a report record rides the `appendLifecycleAction` extension door, which takes an
// opaque activity type and leaves the payload shape to the host. They are restated here as cli
// primitives rather than re-exported from the harness seam, for the same reason
// `RunObservedSnapshot` is (see `types/events.ts`): the bus contract is the cli's, so a widened
// harness shape must fail to compile at the bridge, never reach a subscriber unannounced.

/**
 * A created agent session of an analysis — the payload of `prov.session_created`.
 *
 * One shape covers both kinds, because to start a session is one domain action and the kind is its
 * data. A root session carries no parent, so `parentThreadId` is absent on it.
 */
export type ProvSessionRef = {
    /** The thread that identifies the session; the key every later report act names. */
    threadId: string;
    /** `report` sessions get an `inflexa:Report` entity; a `conversation` is the session alone. */
    kind: "conversation" | "report";
    /** The thread the session was started from, absent on a root session. */
    parentThreadId?: string;
};

/** One block operation on a report document — the payload of the four `prov.report_block_*` members. */
export type ProvReportBlockRef = {
    /** The report session the block belongs to. */
    threadId: string;
    /** The block the act added, changed, removed, or moved. */
    blockId: string;
};

/** A title set on a report document — the payload of `prov.report_title_set`. The title sits on the document, so it names no block. */
export type ProvReportTitleRef = {
    /** The report session whose document carries the title. */
    threadId: string;
    /** The title text the act set. */
    title: string;
};

/** One `(path, content hash)` input of a derivation — the evidence a verifier mounts to reproduce the derived table. */
export type ProvReportDerivationSourceRef = {
    /** The workspace-root-relative path of the source file. */
    path: string;
    /** The content hash of the source at derivation time. */
    hash: string;
};

/**
 * A derivation a report session ran — the payload of `prov.report_derivation_run`.
 *
 * The chain rides the event because the emitting site pins it and a reader cannot rebuild it from
 * the output path alone: the same path can be derived again from different sources.
 */
export type ProvReportDerivationRef = {
    /** The report session that ran the derivation. */
    threadId: string;
    /** The workspace-root-relative path of the derived file. A record is immutable, so a new derivation takes a new path. */
    outputPath: string;
    /** The content hash of the derived file. */
    outputHash: string;
    /** The content hash of the script that produced the derived file. */
    scriptHash: string;
    /** Every source the derivation read, each as a `(path, hash)` pair. */
    sources: readonly ProvReportDerivationSourceRef[];
};

/** A rendered preview of a report document — the payload of `prov.report_previewed`. */
export type ProvReportPreviewRef = {
    /** The report session whose document the page shows. */
    threadId: string;
    /** The workspace-root-relative path of the rendered page. */
    pagePath: string;
    /** The hash of the draft document the page was rendered from, so a reader ties a page to its source. */
    documentHash: string;
};

/** A recorded version of a report — the payload of `prov.report_version_recorded`. */
export type ProvReportVersionRef = {
    /** The report session the version was recorded from. */
    threadId: string;
    /** The version the act recorded. */
    versionId: string;
    /** True when the record superseded an earlier version of the same session. */
    replaced: boolean;
};
