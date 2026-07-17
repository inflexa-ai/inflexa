/**
 * The pinned bge-small embedding model: one URL + SHA-256 + artifact filename,
 * shared by every byte path that handles the model. Kept as a LEAF module (no
 * imports) because scripts/build.ts imports the pin at build time to fetch and
 * embed the model — homing it in setup.ts would evaluate the interactive setup
 * module's whole graph (@clack, the harness package via local-provider) inside
 * the build script, for the sake of three constants.
 *
 * Pinned to the repo revision current as of 2026-07 (last modified 2024-02-17),
 * not `main`: an unpinned ref would let a repo update (or a MITM on the ref)
 * silently swap the model, with only the dimension probe standing between a
 * different model and the vector store. {@link MODEL_SHA256} is the file's LFS
 * object id at this revision and the SOLE integrity authority for every byte
 * source: the build verifies its fetch against it before embedding, and runtime
 * acquisition re-verifies both the embedded copy and the from-source download
 * before any bytes land at the final path.
 *
 * TO BUMP THE PIN (a deliberate, reviewed act): update {@link MODEL_URL} +
 * {@link MODEL_SHA256} here AND — in lockstep — the string-literal import
 * specifier in setup.ts's `embeddedModelPath` (Bun can only embed
 * statically-known paths, so that literal cannot be derived from these
 * constants), plus {@link MODEL_ARTIFACT} if the filename changed. Two
 * build-time guards keep a half-done bump from silently embedding the old
 * model: if the filename changed, the stale-cache sweep deletes the superseded
 * file so a missed import literal fails to resolve (the loud-failure protection
 * LLAMA_RUNTIME_TAG's tag-named archives rely on); if only the revision/hash
 * changed and the filename did NOT — the common bge case, since
 * {@link MODEL_ARTIFACT} carries no revision — the sweep keeps the same-named
 * file and scripts/build.ts's `ensureModelCached` catches it instead, re-hashing
 * the cached bytes against the new SHA-256 and failing the build ("delete the
 * cache") on a mismatch.
 */

/** Download URL for the pinned model revision on HuggingFace. */
export const MODEL_URL =
    "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/d32f8c040ea3b516330eeb75b72bcc2d3a780ab7/bge-small-en-v1.5-q8_0.gguf";

/** SHA-256 of the pinned model file — the sole integrity authority for build-time and runtime verification. */
export const MODEL_SHA256 = "ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514";

/** The model's artifact filename: its name in the build cache, and the embed specifier's basename. */
export const MODEL_ARTIFACT = "bge-small-en-v1.5-q8_0.gguf";
