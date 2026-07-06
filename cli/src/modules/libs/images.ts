/**
 * The published sandbox image variants and their GHCR references — the
 * image-selection contract shared by the `inflexa sandbox pull` handler
 * (modules/libs/pull.ts) and the harness config default
 * (modules/harness/config.ts).
 *
 * The CLI does not map a host architecture onto a track set: the published
 * images are multi-arch manifests, so `docker pull` resolves the host
 * architecture automatically. The user chooses only the VARIANT; the store is
 * baked into the pulled image at `/mnt/libs/current`, so there is no local store
 * directory, no `/mnt/libs` bind mount, and no arch-forcing.
 */

/** GHCR namespace: GitHub Packages on the inf-cli repository. */
const GHCR_NAMESPACE = "ghcr.io/inflexa-ai/inf-cli";

/** The image variants a user can pull, in menu order (lightest first). */
export const SANDBOX_VARIANTS = ["python", "python-r"] as const;

/** A published sandbox image variant. */
export type SandboxVariant = (typeof SANDBOX_VARIANTS)[number];

/** One-line descriptions for the interactive variant chooser. */
export const VARIANT_DESCRIPTIONS: Record<SandboxVariant, string> = {
    python: "Python libraries + bioconda CLI tools + Node packages",
    "python-r": "everything in python, plus the R libraries",
};

/** The multi-arch GHCR image reference (`:latest`) for a variant. */
export function variantImage(variant: SandboxVariant): string {
    return `${GHCR_NAMESPACE}/sandbox-${variant}:latest`;
}

/**
 * The default sandbox image before any explicit pull — the full stack
 * (`python-r`). `ensureSandboxImage` pulls it on first launch when nothing has
 * been configured; `inflexa sandbox pull python` downgrades to the lighter
 * variant.
 */
export const DEFAULT_SANDBOX_IMAGE = variantImage("python-r");

/** Parse a user-supplied variant string; `null` if it is not a known variant. */
export function parseVariant(value: string | undefined): SandboxVariant | null {
    // `as readonly string[]` widens the literal tuple so `.includes` accepts an
    // arbitrary string; `value as SandboxVariant` is then sound because the
    // `.includes` guard has proven membership.
    return value !== undefined && (SANDBOX_VARIANTS as readonly string[]).includes(value) ? (value as SandboxVariant) : null;
}

/**
 * The variant a configured image reference names, or `null` for a reference that
 * is not one of our published variants (e.g. a user's custom `FROM` image).
 * Matches on the `sandbox-<variant>` repository, tolerating any tag or digest.
 * Checks the longer variant first so `sandbox-python-r` is never misread as
 * `sandbox-python`.
 */
export function variantOfImage(ref: string): SandboxVariant | null {
    for (const v of ["python-r", "python"] as const) {
        const repo = `${GHCR_NAMESPACE}/sandbox-${v}`;
        if (ref === repo || ref.startsWith(`${repo}:`) || ref.startsWith(`${repo}@`)) return v;
    }
    return null;
}
