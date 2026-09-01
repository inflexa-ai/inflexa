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
    ProvSessionFileWriteRef,
    ProvSessionRef,
    ProvReportBlockRef,
    ProvReportTitleRef,
    ProvReportDerivationSourceRef,
    ProvReportDerivationRef,
    ProvReportPreviewRef,
    ProvReportVersionRef,
    VerifyResult,
} from "@inflexa-ai/prov-kernel";
