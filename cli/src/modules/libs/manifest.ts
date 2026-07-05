/**
 * Manifest resolution + content verification — the read side of the build
 * change's producer/consumer contract. The build change publishes an immutable
 * tree under a public bucket/CDN, one manifest per architecture:
 *
 * ```
 *  <base>/latest/<arch>/manifest.json     ← the latest pointer
 *  <base>/<version>/<arch>/manifest.json  ← a pinned version
 *  <base>/<version>/<arch>/<track>.tar.zst   ← the tarballs
 * ```
 *
 * A manifest pins each track's `url`, `sha256`, and `size`. The pull is
 * anonymous (public-read bucket) so no credentials ride the request.
 *
 * TODO(extend): auth'd/private stores are out of scope — the OSS pull is
 * anonymous against a public bucket. A credentialed store would add an auth
 * header to {@link fetchManifest} and the track downloads.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { readConfig } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import type { Arch } from "./arch.ts";

/**
 * Compiled default base URL for the published store. Overridden by
 * `INFLEXA_LIB_STORE_URL` (env) or `libStoreUrl` (config) — see
 * {@link resolveBaseUrl}. Points at the public OSS bucket; the bucket must be
 * public-read so an anonymous GET works with no credentials.
 */
const DEFAULT_LIB_STORE_URL = "https://lib-store.inflexa.ai";

/**
 * Resolve the store base URL: `INFLEXA_LIB_STORE_URL` env → `libStoreUrl` config
 * → the compiled default. Trailing slashes are trimmed so URL joins are clean.
 */
export function resolveBaseUrl(): string {
    const raw = env.libStoreUrl ?? readConfig().libStoreUrl ?? DEFAULT_LIB_STORE_URL;
    return raw.replace(/\/+$/, "");
}

/**
 * A published version, validated as a single SAFE path segment. The value is
 * `join()`ed under the store root to form the version and staging directories
 * (`store.ts`), so an unvalidated value from a hijacked/malicious store host —
 * e.g. `"../../../home/<user>/x"` — would let those paths ESCAPE the store root,
 * and `activate`'s replace branch could rename an arbitrary user directory aside
 * and later prune it. The anchored pattern admits only the version alphabet and
 * rejects a path separator, a leading `.` (so `.`, `..`, and dotfiles cannot slip
 * through), and anything else. This is the FIRST line of defense; `versionDir` /
 * `newStagingDir` assert containment as belt-and-suspenders.
 */
const safeVersion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe path segment (no `/`, no `..`, no leading `.`)");

/** One track entry in a manifest: where to fetch it, its digest, and its byte size. */
export type TrackEntry = z.infer<typeof trackEntrySchema>;
const trackEntrySchema = z.object({
    /**
     * Store-relative path to the tarball (e.g. `20260704-x/linux-amd64/cran.tar.zst`).
     * Preferred over {@link TrackEntry.url}: the pull joins it onto the RESOLVED base
     * (`resolveBaseUrl()`), so an `INFLEXA_LIB_STORE_URL`/`libStoreUrl` mirror redirects
     * the PAYLOAD downloads too, not just the manifest (the air-gapped-mirror case).
     * Optional for compatibility with a manifest that predates the field.
     */
    path: z.string().optional(),
    /** Absolute tarball URL as baked by the producer. Fallback when {@link TrackEntry.path} is absent. */
    url: z.string(),
    sha256: z.string(),
    size: z.number().int().nonnegative(),
});

/**
 * A resolved manifest: the concrete version it names plus its per-track pins.
 * `version` lets the pull short-circuit to "up to date" when the active store
 * already equals what `latest` resolves to.
 */
export type Manifest = z.infer<typeof manifestSchema>;
const manifestSchema = z.object({
    version: safeVersion,
    tracks: z.record(z.string(), trackEntrySchema),
});

/**
 * A manifest could not be resolved. Every failure mode — transport, HTTP status,
 * malformed JSON, schema mismatch, or an aborted (timed-out) fetch — folds onto
 * this single variant so callers report one clear "could not resolve the store"
 * message instead of branching on the failure kind.
 */
export type ManifestError = { readonly type: "manifest_failed"; readonly message: string; readonly cause?: unknown };

/** Build the manifest URL for an arch, targeting `latest` or a pinned version. */
export function manifestUrl(base: string, arch: Arch, version?: string): string {
    const seg = version ?? "latest";
    return `${base}/${seg}/${arch}/manifest.json`;
}

/**
 * Fetch and validate a manifest. Any transport, HTTP, JSON, or schema failure is
 * folded onto the error channel as `manifest_failed` — never thrown — so the
 * caller reports one clear "could not resolve the store" message. Callers on a
 * latency-sensitive path (e.g. the pre-launch offer) pass an `AbortSignal` so a
 * blackholed host cannot stall indefinitely; the abort surfaces as `manifest_failed`.
 */
export async function fetchManifest(url: string, signal?: AbortSignal): Promise<Result<Manifest, ManifestError>> {
    let response: Response;
    try {
        response = await fetch(url, { signal });
    } catch (cause) {
        return err({
            type: "manifest_failed",
            message: `Could not reach the library store at ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
        });
    }
    if (!response.ok) {
        return err({ type: "manifest_failed", message: `Library store returned HTTP ${response.status} ${response.statusText} for ${url}` });
    }

    let parsed: unknown; // wire JSON, validated by the zod schema below
    try {
        parsed = await response.json();
    } catch (cause) {
        return err({ type: "manifest_failed", message: `Manifest at ${url} is not valid JSON`, cause });
    }

    const result = manifestSchema.safeParse(parsed);
    if (!result.success) {
        return err({
            type: "manifest_failed",
            message: `Manifest at ${url} does not match the expected shape: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
        });
    }
    return ok(result.data);
}
