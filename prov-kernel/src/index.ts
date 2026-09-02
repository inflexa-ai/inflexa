/**
 * `@inflexa-ai/prov-kernel` — the Inflexa provenance format kernel. The public surface is the Inflexa
 * PROV dialect: the document model (QName derivation, unify options, injectable digest, the
 * `appendLifecycleAction` extension primitive), the core event union and its apply function, the
 * lineage read model, the chain-hash and Ed25519 sign/verify primitives, the signed-attestation
 * schema, and the actor/ref value types the events carry.
 *
 * Deliberately absent: any recorder lifecycle (sink, flush, queue, CAS), signer wiring, or
 * harness dependency. Each host owns its own recorder and emission policy; the kernel owns the
 * representation and its integrity.
 */

export type {
    ProvActor,
    ProvModelId,
    ProvSubject,
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
    ProvCallRef,
    ProvSessionRef,
    ProvReportBlockRef,
    ProvReportTitleRef,
    ProvReportDerivationSourceRef,
    ProvReportDerivationRef,
    ProvReportPreviewRef,
    ProvReportVersionRef,
    VerifyResult,
} from "./types.js";

// Extension mechanism: `appendLifecycleAction`, the QName derivations, and tsprov interop. The per-core-event builders are internal — `applyProvEvent` is the sole supported producer of core statements.
export { createProvDocumentModel, defaultProvDigest, PROV_UNIFY_OPTIONS } from "./document.js";
export type { ProvDigest, ProvDocumentModel, ProvDocumentModelOptions } from "./document.js";

export { applyProvEvent } from "./events.js";
export type { ProvEvent } from "./events.js";

export { computeLineage, computeReachable, deriveLineageModel, findFileEntity } from "./lineage.js";
export type {
    LineageActivityKind,
    LineageActivityNode,
    LineageAgentKind,
    LineageAgentNode,
    LineageAnalysisNode,
    LineageEdge,
    LineageEdgeKind,
    LineageFileNode,
    LineageInputNode,
    LineageModel,
    LineageNode,
    LineageReportNode,
    LineageReportVersionNode,
    LineageWalk,
    ProvReadError,
} from "./lineage.js";

export {
    computeChainHash,
    computePayloadDigest,
    createKeypairSigner,
    importPrivateKeyJwk,
    importPublicKeyJwk,
    signHexDigest,
    verifyHexDigest,
} from "./signing.js";
export type { ProvPublicKeyJwk, ProvSigner, ProvSigningError } from "./signing.js";

export { attestationSchema, buildAttestation, formatVerifyResult, verifyAttestation, verifyPayload, verifyProvenance } from "./verify.js";
export type { ProvAttestation } from "./verify.js";
