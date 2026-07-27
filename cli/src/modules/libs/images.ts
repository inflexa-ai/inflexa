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

/** GHCR namespace: the inflexa-ai org's GitHub Packages (linked to the inflexa repo via the image's source label). */
const GHCR_NAMESPACE = "ghcr.io/inflexa-ai";

/** Strict release tag carried by every published selectable sandbox image. */
export type SandboxVersion = string & { readonly __sandboxVersion: unique symbol };

/** The OCI label carrying the image's human-readable published version. */
export const SANDBOX_VERSION_LABEL = "org.opencontainers.image.version";

/** The image variants a user can pull, in menu order (lightest first). */
export const SANDBOX_VARIANTS = ["python", "python-r"] as const;

/** A published sandbox image variant. */
export type SandboxVariant = (typeof SANDBOX_VARIANTS)[number];

/** Human-readable labels for the interactive variant chooser (the option title). */
export const VARIANT_LABELS: Record<SandboxVariant, string> = {
    python: "Python",
    "python-r": "Python + R",
};

/** One-line descriptions for the interactive variant chooser (the option hint). */
export const VARIANT_DESCRIPTIONS: Record<SandboxVariant, string> = {
    python: "Python libraries + bioconda CLI tools + Node packages",
    "python-r": "everything in python, plus the R libraries",
};

/** The first-party GHCR repository for a selectable variant, without a tag. */
export function variantRepository(variant: SandboxVariant): string {
    return `${GHCR_NAMESPACE}/sandbox-${variant}`;
}

/** The moving multi-arch discovery reference (`:latest`) for a variant. */
export function variantImage(variant: SandboxVariant): string {
    return `${variantRepository(variant)}:latest`;
}

/** Validate and brand a published `<YYYYMMDD>-<7-hex-revision>` version. */
export function parseSandboxVersion(value: string): SandboxVersion | null {
    // The regex proves the release-tag grammar before the string receives its
    // domain brand; callers cannot construct repository or command text from
    // unvalidated registry metadata.
    return /^[0-9]{8}-[0-9a-f]{7}$/.test(value) ? (value as SandboxVersion) : null;
}

/** Build the immutable-by-policy execution reference for a validated version. */
export function versionedVariantImage(variant: SandboxVariant, version: SandboxVersion): string {
    return `${variantRepository(variant)}:${version}`;
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
        const repo = variantRepository(v);
        if (ref === repo || ref.startsWith(`${repo}:`) || ref.startsWith(`${repo}@`)) return v;
    }
    return null;
}

/** Parse a strict published version reference, excluding `latest`, digests, and custom tags. */
export function publishedVersionOfImage(ref: string): { readonly variant: SandboxVariant; readonly version: SandboxVersion } | null {
    const variant = variantOfImage(ref);
    if (variant === null) return null;
    const prefix = `${variantRepository(variant)}:`;
    if (!ref.startsWith(prefix) || ref.includes("@")) return null;
    const version = parseSandboxVersion(ref.slice(prefix.length));
    return version === null ? null : { variant, version };
}
