import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";

import { bakedEnv, env } from "../../lib/env.ts";

/**
 * offline_access is required: inf-cli's sliding session (log in once, renew on
 * use) depends on rotating refresh tokens. This deliberately diverges from
 * nxctl, which forbids the scope because it is a high-privilege admin tool.
 */
const AUTH_SCOPE = "openid profile email offline_access";

/**
 * Remaining validity below which the access token is refreshed: covers clock
 * skew and the latency between this check and the server seeing the request.
 */
const EXPIRY_BUFFER_MS = 60_000;

/**
 * A login the user may already be approving in the browser shouldn't die on one
 * network blip. Tolerate this many *consecutive* failed polls (a thrown request
 * or an unparsable body) before giving up; any valid response resets the
 * count, and the device-code deadline still bounds the overall wait.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/**
 * Concurrent-refresh guard. Rotating refresh tokens make a concurrent refresh
 * dangerous: two processes presenting the same refresh token trip Auth0's
 * reuse-detection, which revokes the entire grant family and silently logs the
 * user out. A cross-process advisory lock serializes renewals. A healthy holder
 * is bounded by the 15s request timeout, so a lock older than this belongs to a
 * crashed process and may be reclaimed.
 */
const LOCK_STALE_MS = 30_000;
/**
 * How long a waiting process spins for the lock before erroring — above the max
 * healthy hold time so it never abandons a live refresh, yet below the staleness
 * threshold so a crashed holder's lock is always reclaimed first.
 */
const LOCK_WAIT_MS = 20_000;
const LOCK_POLL_MS = 150;

export type Auth0Config = {
    domain: string;
    clientId: string;
    audience: string;
};

/**
 * Persisted shape of auth.json. expiresAt is an ISO-8601 instant computed from
 * the token response's relative expires_in at save time.
 */
const storedAuthSchema = z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    idToken: z.string(),
    expiresAt: z.string(),
});
export type StoredAuth = z.infer<typeof storedAuthSchema>;

export type DeviceCodeResponse = {
    deviceCode: string;
    userCode: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
};

export type AuthError =
    | { type: "missing_config"; missingVars: string[] }
    | { type: "not_authenticated" }
    | { type: "device_code_request_failed"; detail: string }
    | { type: "token_poll_failed"; detail: string }
    | { type: "authorization_expired" }
    | { type: "authorization_denied" }
    | { type: "refresh_failed"; detail: string }
    | { type: "revoke_failed"; detail: string }
    | { type: "token_read_failed"; cause: unknown }
    | { type: "token_write_failed"; cause: unknown };

/**
 * Auth0 wire shapes — snake_case comes from the OAuth 2.0 protocol. External
 * input, so each response is schema-validated before any field is trusted.
 */
const deviceCodeWireSchema = z.object({
    device_code: z.string(),
    user_code: z.string(),
    verification_uri_complete: z.string(),
    expires_in: z.number(),
    interval: z.number(),
});

const tokenWireSchema = z.object({
    access_token: z.string().optional(),
    refresh_token: z.string().optional(),
    id_token: z.string().optional(),
    expires_in: z.number().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
});
type TokenWire = z.infer<typeof tokenWireSchema>;

export function describeAuthError(error: AuthError): string {
    switch (error.type) {
        case "missing_config":
            return `This build has no Auth0 configuration (missing: ${error.missingVars.join(", ")}). Release binaries are built with these baked in; for development, set them in your environment or .env.`;
        case "not_authenticated":
            return "Not logged in — run `inf auth login`.";
        case "device_code_request_failed":
            return `Could not start the login flow: ${error.detail}`;
        case "token_poll_failed":
            return `Login failed: ${error.detail}`;
        case "authorization_expired":
            return "The login code expired before it was confirmed — run `inf auth login` again.";
        case "authorization_denied":
            return "Authorization was denied in the browser.";
        case "refresh_failed":
            return `Could not renew the session (${error.detail}) — run \`inf auth login\`.`;
        case "revoke_failed":
            return `Could not revoke the session at Auth0: ${error.detail}`;
        case "token_read_failed":
            return `Could not read the stored auth tokens: ${String(error.cause)}`;
        case "token_write_failed":
            return `Could not write the auth token file: ${String(error.cause)}`;
    }
}

export function resolveAuth0Config(): Result<Auth0Config, AuthError> {
    const domain = bakedEnv.auth0Domain;
    const clientId = bakedEnv.auth0ClientId;
    const audience = bakedEnv.auth0Audience;
    if (domain && clientId && audience) return ok({ domain, clientId, audience });

    const missingVars = [...(domain ? [] : ["INF_AUTH0_DOMAIN"]), ...(clientId ? [] : ["INF_AUTH0_CLIENT_ID"]), ...(audience ? [] : ["INF_AUTH0_AUDIENCE"])];
    return err({ type: "missing_config", missingVars });
}

export function loadAuth(): Result<StoredAuth, AuthError> {
    let raw: string;
    try {
        raw = readFileSync(env.authPath, "utf8");
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return err({ type: "not_authenticated" });
        return err({ type: "token_read_failed", cause });
    }

    const parsed = JSON.parseWith(raw, storedAuthSchema);
    if (parsed === null) return err({ type: "token_read_failed", cause: "auth.json is malformed" });
    return ok(parsed);
}

export function saveAuth(auth: StoredAuth): Result<void, AuthError> {
    return Result.fromThrowable(
        () => {
            mkdirSync(dirname(env.authPath), { recursive: true });
            // Write-then-rename keeps the update atomic: with refresh token
            // rotation, a partially written file would strand a dead token
            // and force a re-login.
            const tmpPath = env.authPath + ".tmp";
            writeFileSync(tmpPath, JSON.stringify(auth, null, 4) + "\n", { mode: 0o600 });
            renameSync(tmpPath, env.authPath);
        },
        (cause): AuthError => ({ type: "token_write_failed", cause }),
    )();
}

export function deleteAuth(): Result<void, AuthError> {
    return Result.fromThrowable(
        // force: a missing file is fine — logout is idempotent.
        () => rmSync(env.authPath, { force: true }),
        (cause): AuthError => ({ type: "token_write_failed", cause }),
    )();
}

export async function requestDeviceCode(config: Auth0Config): Promise<Result<DeviceCodeResponse, AuthError>> {
    let response: Response;
    let raw: string;
    try {
        response = await postForm(`https://${config.domain}/oauth/device/code`, {
            client_id: config.clientId,
            scope: AUTH_SCOPE,
            audience: config.audience,
        });
        raw = await response.text();
    } catch (cause) {
        return err({ type: "device_code_request_failed", detail: String(cause) });
    }

    if (!response.ok) {
        const failure = JSON.parseWith(raw, tokenWireSchema);
        return err({ type: "device_code_request_failed", detail: failure?.error_description ?? `HTTP ${response.status}: ${raw}` });
    }

    const wire = JSON.parseWith(raw, deviceCodeWireSchema);
    if (wire === null) {
        return err({ type: "device_code_request_failed", detail: `unexpected response: ${raw}` });
    }

    return ok({
        deviceCode: wire.device_code,
        userCode: wire.user_code,
        verificationUriComplete: wire.verification_uri_complete,
        expiresIn: wire.expires_in,
        interval: wire.interval,
    });
}

export async function pollForToken(config: Auth0Config, device: DeviceCodeResponse): Promise<Result<StoredAuth, AuthError>> {
    // Floor at 1s so a zero/absent server interval cannot busy-loop.
    let intervalSeconds = Math.max(device.interval, 1);
    const deadline = Date.now() + device.expiresIn * 1000;
    let consecutiveFailures = 0;

    while (Date.now() < deadline) {
        await Promise.sleep(intervalSeconds * 1000);

        let raw: string;
        try {
            const response = await postForm(`https://${config.domain}/oauth/token`, {
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                device_code: device.deviceCode,
                client_id: config.clientId,
            });
            raw = await response.text();
        } catch (cause) {
            // A transient blip (or the 15s request timeout) shouldn't abort a
            // login the user may already have approved — retry within budget.
            // The loop sleeps `interval` before the next attempt, so retries are
            // already paced.
            if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                return err({ type: "token_poll_failed", detail: String(cause) });
            }
            continue;
        }

        const wire = JSON.parseWith(raw, tokenWireSchema);
        if (wire === null) {
            // An unparsable body is the same class of transient failure (e.g. a
            // proxy's HTML error page mid-outage) — count it, don't bail.
            if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                return err({ type: "token_poll_failed", detail: `unexpected response: ${raw}` });
            }
            continue;
        }
        consecutiveFailures = 0;

        // Outcomes are classified by the body's `error` field, never the HTTP
        // status — Auth0 deviates from RFC 8628 (403 for pending, 429 for slow_down).
        switch (wire.error) {
            case undefined:
                return tokenWireToStoredAuth(wire, null).mapErr((detail): AuthError => ({ type: "token_poll_failed", detail }));
            case "authorization_pending":
                continue;
            case "slow_down":
                intervalSeconds += 5; // RFC 8628 §3.5
                continue;
            case "expired_token":
                return err({ type: "authorization_expired" });
            case "access_denied":
                return err({ type: "authorization_denied" });
            default:
                return err({ type: "token_poll_failed", detail: wire.error_description ?? wire.error });
        }
    }

    return err({ type: "authorization_expired" });
}

export async function refreshAccessToken(config: Auth0Config, current: StoredAuth): Promise<Result<StoredAuth, AuthError>> {
    let response: Response;
    let raw: string;
    try {
        response = await postForm(`https://${config.domain}/oauth/token`, {
            grant_type: "refresh_token",
            client_id: config.clientId,
            refresh_token: current.refreshToken,
        });
        raw = await response.text();
    } catch (cause) {
        return err({ type: "refresh_failed", detail: String(cause) });
    }

    const wire = JSON.parseWith(raw, tokenWireSchema);
    if (wire === null) return err({ type: "refresh_failed", detail: `unexpected response: ${raw}` });
    if (!response.ok || wire.error) {
        return err({ type: "refresh_failed", detail: wire.error_description ?? wire.error ?? `HTTP ${response.status}` });
    }

    // Persist before returning: rotation invalidated the refresh token we just
    // used, so the rotated one must hit disk before anyone acts on the result.
    return tokenWireToStoredAuth(wire, current)
        .mapErr((detail): AuthError => ({ type: "refresh_failed", detail }))
        .andThen((next) => saveAuth(next).map(() => next));
}

export async function getValidAccessToken(): Promise<Result<string, AuthError>> {
    return loadAuth().asyncAndThen((auth) => {
        if (!isExpiring(auth)) return okAsync<string, AuthError>(auth.accessToken);
        return resolveAuth0Config().asyncAndThen((config) => new ResultAsync(refreshUnderLock(config)));
    });
}

/**
 * Serializes the refresh across processes. Rotating refresh tokens make a
 * concurrent refresh dangerous: a second process replaying the same refresh
 * token trips Auth0's reuse-detection, which revokes the whole grant family and
 * silently logs the user out. A cross-process advisory lock pins one refresher
 * at a time; the re-read under the lock — not the lock alone — is what prevents
 * the revocation, since a process that waited must use the token the winner just
 * wrote rather than replay its own now-stale one.
 */
async function refreshUnderLock(config: Auth0Config): Promise<Result<string, AuthError>> {
    const lock = await acquireRefreshLock();
    if (lock.isErr()) return err(lock.error);
    const token = lock.value;
    try {
        // `return await` so the lock is held until the refresh resolves, not
        // released the moment the promise is created.
        return await loadAuth().asyncAndThen((fresh) =>
            isExpiring(fresh)
                ? new ResultAsync(refreshAccessToken(config, fresh)).map((next) => next.accessToken)
                : okAsync<string, AuthError>(fresh.accessToken),
        );
    } finally {
        releaseRefreshLock(token);
    }
}

export async function revokeRefreshToken(config: Auth0Config, refreshToken: string): Promise<Result<void, AuthError>> {
    let response: Response;
    try {
        response = await postForm(`https://${config.domain}/oauth/revoke`, {
            client_id: config.clientId,
            token: refreshToken,
        });
    } catch (cause) {
        return err({ type: "revoke_failed", detail: String(cause) });
    }

    if (!response.ok) {
        return err({ type: "revoke_failed", detail: `HTTP ${response.status}: ${await response.text()}` });
    }
    return ok(undefined);
}

/**
 * True when the access token has at most the safety buffer of validity left and
 * therefore warrants a refresh.
 */
export function isExpiring(auth: StoredAuth): boolean {
    return new Date(auth.expiresAt).getTime() - Date.now() <= EXPIRY_BUFFER_MS;
}

function refreshLockPath(): string {
    return env.authPath + ".lock";
}

/**
 * Acquires an exclusive advisory lock by atomically creating the lock file
 * (`wx` = O_EXCL). On contention, a lock older than LOCK_STALE_MS belongs to a
 * crashed holder and is reclaimed; otherwise we spin until it frees up or the
 * wait budget elapses. getValidAccessToken only locks after a successful
 * loadAuth, so the parent directory is guaranteed to exist. Returns a token
 * identifying this acquisition (written into the file) so release can confirm
 * we still own the lock before deleting it.
 */
async function acquireRefreshLock(): Promise<Result<string, AuthError>> {
    const path = refreshLockPath();
    // pid + high-resolution timestamp: unique per acquisition, so a process that
    // reclaimed our lock as stale writes a different token and we won't delete it.
    const token = `${process.pid} ${new Date().toISOString()}`;
    const giveUpAt = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            writeFileSync(path, token + "\n", { flag: "wx", mode: 0o600 });
            return ok(token);
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
                return err({ type: "token_write_failed", cause });
            }
        }

        if (lockAgeMs(path) > LOCK_STALE_MS) {
            // Reclaim a crashed holder's lock, then loop to re-create our own.
            rmSync(path, { force: true });
            continue;
        }

        if (Date.now() >= giveUpAt) {
            return err({ type: "refresh_failed", detail: "timed out waiting for another inf process to finish renewing the session" });
        }
        await Promise.sleep(LOCK_POLL_MS);
    }
}

/**
 * Age of the lock from its mtime; Infinity if it has vanished (holder just
 * released it), so the caller retries creation immediately.
 */
function lockAgeMs(path: string): number {
    try {
        return Date.now() - statSync(path).mtimeMs;
    } catch {
        return Infinity;
    }
}

/**
 * Releases the lock only if we still hold it. A healthy holder's window (≤15s
 * request timeout) is well under LOCK_STALE_MS, so this practically always
 * matches; but if our refresh somehow overran and another process reclaimed the
 * lock as stale, its token differs and we must not delete the lock it now owns.
 */
function releaseRefreshLock(token: string): void {
    let current: string;
    try {
        current = readFileSync(refreshLockPath(), "utf8");
    } catch {
        return; // already gone — nothing to release
    }
    // Compare ignoring the trailing newline we wrote with the token.
    if (current.trim() === token) {
        rmSync(refreshLockPath(), { force: true });
    }
}

/**
 * Builds the persisted shape from a successful token response. `previous`
 * fills fields a refresh response may legally omit (rotated refresh token,
 * id_token); on first login it is null and everything must be present.
 * Returns a detail string error so callers can wrap it in the right variant.
 */
export function tokenWireToStoredAuth(wire: TokenWire, previous: StoredAuth | null): Result<StoredAuth, string> {
    const refreshToken = wire.refresh_token ?? previous?.refreshToken;
    const idToken = wire.id_token ?? previous?.idToken;
    if (!wire.access_token || typeof wire.expires_in !== "number" || !idToken) {
        return err("token response is missing required fields");
    }
    if (!refreshToken) {
        // Without a refresh token there is no sliding session — fail loudly
        // instead of silently degrading to daily re-logins.
        return err("no refresh token issued — enable 'Allow Offline Access' on the Auth0 API and the Refresh Token grant on the application");
    }
    return ok({
        accessToken: wire.access_token,
        refreshToken,
        idToken,
        expiresAt: new Date(Date.now() + wire.expires_in * 1000).toISOString(),
    });
}

async function postForm(url: string, fields: Record<string, string>): Promise<Response> {
    return fetch(url, {
        method: "POST",
        body: new URLSearchParams(fields),
        // A hung request should fail the command, not freeze it forever.
        signal: AbortSignal.timeout(15_000),
    });
}
