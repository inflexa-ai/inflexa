/**
 * The published container images and their GHCR references — the image contract
 * shared by the `inflexa sandbox pull` handler (modules/libs/pull.ts), the harness
 * config default (modules/harness/config.ts), and the store-management commands
 * (modules/libs/store.ts).
 *
 * The CLI does not map a host architecture onto a track set: the published images
 * are multi-arch manifests, so `docker pull` resolves the host architecture
 * automatically.
 *
 * One runtime image is published, thus a user selects nothing. That image bakes no
 * R library and no Python library — its `/mnt/libs/current` is empty — so the
 * packages come from the host package store, which the harness bind-mounts at
 * `/mnt/libs` for every sandbox. The image keeps the language interpreters, the
 * system libraries, and the two tracks a farm cannot carry, which are conda and
 * Node.
 */

/** GHCR namespace: the inflexa-ai org's GitHub Packages (linked to the inflexa repo via the image's source label). */
const GHCR_NAMESPACE = "ghcr.io/inflexa-ai";

/** The repository of the one published runtime image, without a tag. */
const SANDBOX_REPOSITORY = `${GHCR_NAMESPACE}/sandbox-base`;

/** The one published runtime image a sandbox launches on, at its moving `:latest` tag. */
export const SANDBOX_IMAGE = `${SANDBOX_REPOSITORY}:latest`;

/**
 * The provisioner image the store-management commands run to add, remove, or
 * reclaim store content.
 *
 * It is a constant and not a configuration value. The provisioner offers no
 * variant: either the machine holds it or it does not, thus a user chooses
 * nothing. A reference a user could override would only ever name a wrong-version
 * provisioner against the store that this CLI writes.
 */
export const PROVISIONER_IMAGE = `${GHCR_NAMESPACE}/sandbox-provisioner:latest`;

/**
 * Whether `ref` names the published runtime image, at any tag or digest.
 *
 * A reference that does not is a custom image the user built themselves, and no
 * registry can supply it. The two pre-flight paths that offer a pull consult this
 * before they offer one, so a custom tag gets the build hint instead of a pull
 * that could only fail.
 */
export function isPublishedSandboxImage(ref: string): boolean {
    return ref === SANDBOX_REPOSITORY || ref.startsWith(`${SANDBOX_REPOSITORY}:`) || ref.startsWith(`${SANDBOX_REPOSITORY}@`);
}
