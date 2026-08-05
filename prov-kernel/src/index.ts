/**
 * `@inflexa-ai/prov-kernel` — the Inflexa provenance format kernel. The public surface is the Inflexa
 * PROV dialect: the document model (QName derivation, tsprov statement builders, unify options,
 * injectable digest), the chain-hash and Ed25519 sign/verify primitives, the signed-sidecar
 * schema, and the actor/ref value types the builders accept.
 *
 * Deliberately absent: any event vocabulary, event reducer, or recorder lifecycle. Each host owns
 * its own event set and recorder; the kernel owns only the representation and its integrity.
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
    VerifyResult,
} from "./types.js";

export { createProvDocumentModel, defaultProvDigest, PROV_UNIFY_OPTIONS } from "./document.js";
export type { ProvDigest, ProvDocumentModel, ProvDocumentModelOptions } from "./document.js";

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

export { buildSidecar, formatVerifyResult, sidecarSchema, verifyPayload, verifyProvenance, verifySidecar } from "./verify.js";
export type { Sidecar } from "./verify.js";
