/**
 * The identity of the sandbox workload on the Docker backend, from the executor fact.
 *
 * A bind mount shows the owner and the mode of each file as the engine maps them. The
 * workload must be a user that the engine maps onto the owner of the files of the user,
 * or the sandbox cannot read the inputs, import from the store, or write its step tree.
 * One rule selects that user from the engine, and this file holds the rule.
 */

/** The image user that the entrypoint drops to when the env names no other user. */
const IMAGE_USER_ID = 1000;

/** The user of the executor host that a sandbox acts for. */
export type ExecutorUser = {
    readonly uid: number;
    readonly gid: number;
    /** The supplementary gids. A project group gives its data to the sandbox only through this list. */
    readonly groups: readonly number[];
};

/**
 * How the engine that runs the sandbox containers maps the ids of a container onto the
 * files of the host. It is a fact of the executor, the machine that runs the containers,
 * not of the harness process: a remote executor runs on a different machine, with a
 * different user. Thus the embedder detects it where the engine runs, and the harness never
 * reads the ids of its own process for it.
 *
 * - `vm`: the engine runs in a VM, and a file-sharing layer gives the host files to it
 *   (Docker Desktop, OrbStack, a Podman machine). `masked` means that the layer shows the
 *   files as writable to each container user. `host-preserved` means that the layer shows
 *   the true host owner, thus the image user is a stranger to the files.
 * - `rootful`: a container uid is the same host uid (rootful Docker or rootful Podman on
 *   Linux). The workload drops to the host user.
 * - `rootless-podman`: Podman maps the container ids into the subordinate ids of the user.
 *   `keep-id` maps the user onto the image user.
 *
 * `selinux` is true when the engine labels its containers. Then the labels block each bind
 * mount, and the sandbox turns the label separation off for its container. It never
 * relabels a host file.
 */
export type SandboxExecutor =
    | { readonly kind: "vm"; readonly bindOwnership: "masked" | "host-preserved" }
    | { readonly kind: "rootful"; readonly user: ExecutorUser; readonly selinux: boolean }
    | { readonly kind: "rootless-podman"; readonly selinux: boolean };

/** The container settings and the step-tree access that one {@link SandboxExecutor} demands. */
export type WorkloadIdentity = {
    /** The env that tells the entrypoint which user to drop to. */
    readonly env: Readonly<Record<string, string>>;
    /** Added to `HostConfig.SecurityOpt`, after `no-new-privileges`. */
    readonly securityOpt: readonly string[];
    readonly usernsMode?: string;
    readonly annotations?: Readonly<Record<string, string>>;
    /** The workload is not the owner of the step tree that the host makes, thus the host opens the tree to each user. */
    readonly stepTreeAccess?: "world-writable";
};

/**
 * The one rule. An absent executor is a VM engine whose file sharing masks the owner, the
 * engine that needs nothing.
 *
 * A host uid 0 stays the image user: sandbox-server refuses to run as root under the egress
 * firewall. That user is then a stranger to the files of root, thus the step tree opens to it.
 */
export function workloadIdentityOf(executor: SandboxExecutor | undefined): WorkloadIdentity {
    if (executor === undefined) return { env: {}, securityOpt: [] };
    switch (executor.kind) {
        case "vm":
            return executor.bindOwnership === "host-preserved" ? { env: {}, securityOpt: [], stepTreeAccess: "world-writable" } : { env: {}, securityOpt: [] };
        case "rootful": {
            const securityOpt = labelOpt(executor.selinux);
            if (executor.user.uid === 0) return { env: {}, securityOpt, stepTreeAccess: "world-writable" };
            return {
                env: {
                    SANDBOX_UID: String(executor.user.uid),
                    SANDBOX_GID: String(executor.user.gid),
                    SANDBOX_GROUPS: executor.user.groups.join(","),
                },
                securityOpt,
            };
        }
        case "rootless-podman":
            return {
                env: { SANDBOX_KEEP_GROUPS: "1" },
                securityOpt: labelOpt(executor.selinux),
                usernsMode: `keep-id:uid=${IMAGE_USER_ID},gid=${IMAGE_USER_ID}`,
                // `--group-add keep-groups` is a translation of the Podman CLI only, and the
                // compat API takes `GroupAdd` as a list of group names. The annotation is what
                // the CLI makes of it, and the compat API passes it into the OCI spec. Only crun
                // reads it, and the groups are those of the API service process.
                annotations: { "run.oci.keep_original_groups": "1" },
            };
        default: {
            const exhaustive: never = executor;
            throw new Error(`unhandled executor: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** `label=disable`, not a `:z` relabel: a relabel changes the label of the host files of the user, and rootless Podman cannot relabel a file that it does not own. */
function labelOpt(selinux: boolean): string[] {
    return selinux ? ["label=disable"] : [];
}
