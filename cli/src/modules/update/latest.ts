import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { err, ok, Result, ResultAsync } from "neverthrow";
import { z } from "zod";

import pkg from "../../../package.json";
import { env, updateNoticeSuppressed } from "../../lib/env.ts";
import { isCompiledBinary } from "../../lib/install_context.ts";
import type { FetchLike } from "../../lib/download.ts";

/** The repository the releases come from. The one place the name appears outside the installers. */
export const RELEASE_REPO = "inflexa-ai/inflexa";

/**
 * The redirect that names the newest release. Reading the redirect TARGET is what `install.sh` does, and
 * it is deliberate: the REST API needs a token above 60 requests an hour from one address, while this
 * page is a plain redirect that no rate limit covers.
 */
export const RELEASES_LATEST_URL = `https://github.com/${RELEASE_REPO}/releases/latest`;

/** How long a recorded read stays good. One day, the interval `gh` and `update-notifier` settled on. */
const READ_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How long the read may take before it is abandoned. It is short because a command the person actually
 * asked for waits behind it: a slow or captive network must cost a moment, never the command.
 */
const READ_TIMEOUT_MS = 3000;

/** Why the newest version could not be read. */
export type LatestVersionError =
    | { readonly type: "network_failed"; readonly cause: unknown }
    | { readonly type: "unexpected_status"; readonly status: number }
    | { readonly type: "no_version"; readonly location: string };

/** A version as its three numbers. A suffix such as `-rc.1` is dropped, because the compare below ignores it. */
type SemVer = { readonly major: number; readonly minor: number; readonly patch: number };

/** Parse `0.16.1` (with or without a leading `v`, with or without a suffix), or `null` when it is not that shape. */
function parseVersion(raw: string): SemVer | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * True when `candidate` is a later release than `current`.
 *
 * A version that does not parse gives `false` on either side. That is the safe direction: an unreadable
 * version must never make the CLI offer an update it cannot describe. A pre-release suffix is ignored, so
 * `0.17.0-rc.1` and `0.17.0` compare equal — the releases this reads are plain, and a rank for the
 * suffixes would be dead code today.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
    const next = parseVersion(candidate);
    const now = parseVersion(current);
    if (next === null || now === null) return false;
    if (next.major !== now.major) return next.major > now.major;
    if (next.minor !== now.minor) return next.minor > now.minor;
    return next.patch > now.patch;
}

/**
 * Read the newest released version from the `releases/latest` redirect.
 *
 * `redirect: "manual"` because the target URL IS the answer: following it would download a whole release
 * page to learn what its `Location` header already said. The tag is `v<version>`, and the leading `v` is
 * dropped so the value compares directly with `package.json`.
 */
export async function fetchLatestVersion(fetchImpl: FetchLike = fetch): Promise<Result<string, LatestVersionError>> {
    // `Promise.resolve().then` rather than a bare call, so a fetch seam that throws SYNCHRONOUSLY lands in
    // the same error channel as one that rejects. A test stub is the realistic thrower.
    const response = await ResultAsync.fromPromise(
        Promise.resolve().then(() => fetchImpl(RELEASES_LATEST_URL, { redirect: "manual", signal: AbortSignal.timeout(READ_TIMEOUT_MS) })),
        (cause): LatestVersionError => ({ type: "network_failed", cause }),
    );
    if (response.isErr()) return err(response.error);

    const location = response.value.headers.get("location");
    if (location === null) return err({ type: "unexpected_status", status: response.value.status });

    const tag = location.split("/").pop() ?? "";
    const version = parseVersion(tag);
    if (version === null) return err({ type: "no_version", location });
    return ok(`${version.major}.${version.minor}.${version.patch}`);
}

/** The on-disk record of the last read. `version` is the newest release that read saw, not the running one. */
const updateStateSchema = z.object({ checkedAt: z.number(), version: z.string() });

type UpdateState = z.infer<typeof updateStateSchema>;

/**
 * The recorded read, or `null`. Absence is the NORMAL condition — no run has read yet — so every fault
 * resolves to `null`: no file, bad bytes, a foreign schema. The cost of an unreadable record is one extra
 * network read, never a failure.
 */
function readState(): UpdateState | null {
    return Result.fromThrowable(
        () => updateStateSchema.safeParse(JSON.parse(readFileSync(env.updateStatePath, "utf8"))),
        () => undefined,
    )().match(
        (parsed) => (parsed.success ? parsed.data : null),
        () => null,
    );
}

/** Record `version` as what the read at `now` saw. A write fault is swallowed for the reason {@link readState} gives. */
function writeState(version: string, now: number): void {
    Result.fromThrowable(
        () => {
            mkdirSync(dirname(env.updateStatePath), { recursive: true });
            writeFileSync(env.updateStatePath, JSON.stringify({ checkedAt: now, version } satisfies UpdateState, null, 4) + "\n");
        },
        () => undefined,
    )().match(
        () => undefined,
        () => undefined,
    );
}

/**
 * Whether this build may look for a newer release at all. Each condition names a build that CANNOT be
 * compared against the release page, or a run that must stay quiet:
 *
 * - `compiled` is false for a source run, which has no released binary to compare
 * - `development` marks a build whose version was never released
 * - `suppressed` is the operator's own choice, and it covers CI
 *
 * The pure decision, split out for the reason `devCommandsActive` in lib/env.ts is: `env` freezes its
 * reads at import, so a test process cannot vary the inputs of the accessor that feeds this.
 */
export function updateReadAllowed(compiled: boolean, development: boolean, suppressed: boolean): boolean {
    return compiled && !development && !suppressed;
}

/**
 * The newest released version when it is later than the running one, else `null`.
 *
 * At most one network read a day, and the recorded answer serves every run in between. This is the whole
 * reason the record exists: a person runs `inflexa` many times an hour, and a network read on each of
 * them would be both slow and rude to the host.
 *
 * Never gives an error. A caller uses this to decorate a run it does not own, so a failed read must read
 * as "nothing to say" — the `infra-state-resilience` spec states the same rule for the stack state.
 *
 * Separate from {@link pendingUpdate} only by the gate above it. A caller in the product always wants the
 * gate, so it always calls the other one.
 */
export async function readNewerVersion(options: { readonly fetch?: FetchLike; readonly now?: number } = {}): Promise<string | null> {
    const now = options.now ?? Date.now();
    const recorded = readState();
    if (recorded !== null && now - recorded.checkedAt < READ_INTERVAL_MS) {
        return isNewerVersion(recorded.version, pkg.version) ? recorded.version : null;
    }

    const latest = await fetchLatestVersion(options.fetch ?? fetch);
    return latest.match(
        (version) => {
            // Recorded even when it equals the running version: the record's job is to hold the NEXT read
            // for a day, and that job is the same whether or not this read found anything new.
            writeState(version, now);
            return isNewerVersion(version, pkg.version) ? version : null;
        },
        // A failed read writes nothing, so the next run reads again rather than waiting out the day on an
        // answer that never arrived.
        () => null,
    );
}

/** The gated read: {@link readNewerVersion} unless {@link updateReadAllowed} says this build must stay quiet. */
export async function pendingUpdate(options: { readonly fetch?: FetchLike; readonly now?: number } = {}): Promise<string | null> {
    if (!updateReadAllowed(isCompiledBinary(), env.isDevelopment, updateNoticeSuppressed())) return null;
    return readNewerVersion(options);
}
