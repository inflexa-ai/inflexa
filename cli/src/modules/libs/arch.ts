/**
 * Architecture detection + the track layout contract.
 *
 * The published store is per-architecture: one manifest per arch pins the
 * tracks built there (amd64 ships the full R + Python + conda stack; arm64
 * ships the non-R tracks only). The CLI never asks the user to choose — the
 * manifest for the detected arch says exactly what to pull.
 */

/** The supported host architectures — the published-store `<arch>` URL segments. */
export const ARCHES = ["linux-amd64", "linux-arm64"] as const;

/** Host architecture, mapped from `uname -m` onto the published-store arch segment. */
export type Arch = (typeof ARCHES)[number];

/**
 * An underlying store track. Each maps to one content-addressed tarball in the
 * manifest and extracts into one fixed subtree of a version directory
 * (see {@link TRACK_SUBTREE}, which mirrors `harness/src/sandbox/mount-plan.ts`).
 */
export type Track = "python" | "conda" | "node" | "cran" | "bioconductor" | "github";

/**
 * Why the R stack is unavailable on arm64 — the SINGLE source of this
 * user-facing rationale, rendered verbatim by the pull note and the
 * `inflexa setup` library-store note (so the explanation never drifts).
 * Mentions "arm64" so each caller can surface it as-is.
 */
export const ARM64_NO_R_REASON =
    "R libraries are not yet built for arm64 (upstream r2u is amd64-only), so the arm64 store carries the Python + conda stack only.";

/**
 * Fixed subtree (relative to a version dir) each track extracts into. This is a
 * contract, not a convention: the resolver env in `harness/src/sandbox/mount-plan.ts`
 * hard-codes `/mnt/libs/current/r/{github,bioconductor,cran}`, `.../node/node_modules`,
 * and `.../conda/bin`, so a track MUST land at exactly these roots.
 */
export const TRACK_SUBTREE: Record<Track, string> = {
    cran: "r/cran",
    bioconductor: "r/bioconductor",
    github: "r/github",
    python: "python",
    node: "node",
    conda: "conda",
};

/**
 * Map an {@link Arch} onto the Docker `--platform` value used to force sandbox
 * containers onto the same architecture as the pulled store (a store's native
 * binaries must never run under a mismatched-arch container).
 */
export const DOCKER_PLATFORM: Record<Arch, string> = {
    "linux-amd64": "linux/amd64",
    "linux-arm64": "linux/arm64",
};

/**
 * Map `uname -m` output onto an {@link Arch}. `null` for an unrecognized machine
 * so the caller can surface an honest "unsupported architecture" rather than
 * guessing wrong. Pure — takes the machine string so it is unit-testable without
 * spawning `uname`.
 */
export function archFromMachine(machine: string): Arch | null {
    const m = machine.trim().toLowerCase();
    if (m === "x86_64" || m === "amd64") return "linux-amd64";
    if (m === "aarch64" || m === "arm64") return "linux-arm64";
    return null;
}

// `uname -m` is stable for a process's lifetime, so the result is memoized: the
// pull/status/pre-launch-offer paths each call detectArch 2–4× per command,
// and re-spawning `uname` every time is pure waste. `undefined` = not yet resolved;
// `null` = resolved but unsupported (a genuine cached outcome, not "unresolved").
let cachedArch: Arch | null | undefined;

/** Detect the host architecture via `uname -m`. `null` on an unrecognized machine or a failed spawn. */
export function detectArch(): Arch | null {
    if (cachedArch !== undefined) return cachedArch;
    try {
        cachedArch = archFromMachine(Bun.spawnSync(["uname", "-m"]).stdout.toString());
    } catch {
        // A failed spawn (no `uname` on PATH, exec denied) folds onto the same in-band
        // null as an unrecognized machine — callers already treat null as "unsupported",
        // and the pre-launch offer (pull.ts offerLibStoreIfMissing) must never throw.
        cachedArch = null;
    }
    return cachedArch;
}
