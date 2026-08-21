/**
 * The published container images and their GHCR references — the image contract
 * shared by the `inflexa sandbox pull` handler (modules/libs/pull.ts), the
 * harness config default (modules/harness/config.ts), the transfer children
 * (modules/libs/transfers.ts), and the store commands (modules/libs/store.ts).
 *
 * The CLI does not map a host architecture onto a track set: the published
 * images are multi-arch manifests, so `docker pull` resolves the host
 * architecture automatically.
 *
 * One runtime image is published, thus a user selects nothing. That image bakes
 * no R library and no Python library, so the packages come from the host
 * package store, which the harness bind-mounts at `/mnt/libs` for every
 * sandbox. The image keeps the language interpreters, the system libraries, and
 * the two tracks a farm cannot carry, which are conda and Node.
 */

/** GHCR namespace: the inflexa-ai org's GitHub Packages (linked to the inflexa repo via the image's source label). */
const GHCR_NAMESPACE = "ghcr.io/inflexa-ai";

/** The repository of the one published runtime image, without a tag. */
const SANDBOX_REPOSITORY = `${GHCR_NAMESPACE}/sandbox-base`;

/** The repository basename of the runtime image, which the provisioner derivation swaps. */
const SANDBOX_BASENAME = "sandbox-base";

/** The repository basename of the provisioner image. */
const PROVISIONER_BASENAME = "sandbox-provisioner";

/** The one published runtime image a sandbox launches on, at its moving `:latest` tag. */
export const SANDBOX_IMAGE = `${SANDBOX_REPOSITORY}:latest`;

/**
 * The provisioner image reference, DERIVED from the configured runtime image:
 * the same registry and the same tag, with the repository basename swapped.
 *
 * No configuration value names the provisioner, thus the image pair cannot
 * skew: a user that pins `sandbox-base:v12` acquires with `sandbox-provisioner:v12`.
 * The two images build from one digest-pinned base for the ABI, and the pair
 * rule is what carries that guarantee to the machine of the user.
 *
 * A reference whose basename is not `sandbox-base` is a custom image. The swap
 * still applies to its basename, because a custom build that follows the naming
 * of the pair keeps working, and no other answer exists for it.
 */
export function provisionerImageFor(sandboxImage: string): string {
    // The tag or digest separator comes AFTER the last `/`, thus the split walks
    // from the last path segment. `@` (digest) binds before `:` (tag), because a
    // digest reference carries both (`repo@sha256:...`).
    const slash = sandboxImage.lastIndexOf("/");
    const name = sandboxImage.slice(slash + 1);
    const at = name.indexOf("@");
    const colon = name.indexOf(":");
    const cut = at >= 0 ? at : colon >= 0 ? colon : name.length;
    const basename = name.slice(0, cut);
    const swapped = basename === SANDBOX_BASENAME ? PROVISIONER_BASENAME : `${basename}-provisioner`;
    return `${sandboxImage.slice(0, slash + 1)}${swapped}${name.slice(cut)}`;
}

/**
 * Whether `ref` names the published runtime image, at any tag or digest.
 *
 * A reference that does not is a custom image the user built themselves, and no
 * registry can supply it. The pre-flight paths that point at `inflexa sandbox
 * pull` consult this first, so a custom tag gets the build hint instead of a
 * pull that could only fail.
 */
export function isPublishedSandboxImage(ref: string): boolean {
    return ref === SANDBOX_REPOSITORY || ref.startsWith(`${SANDBOX_REPOSITORY}:`) || ref.startsWith(`${SANDBOX_REPOSITORY}@`);
}
